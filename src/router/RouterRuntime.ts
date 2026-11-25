import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
  ModelProtocol,
} from "../model/index.js";
import { cloneMessages, downgradeUnsupportedContent, messageContent, ModelRequestError } from "../model/index.js";
import {
  LITELLM_DEFAULT_MAX_RETRIES,
  LITELLM_INITIAL_RETRY_DELAY_MS,
  LITELLM_MAX_RETRY_DELAY_MS,
  LITELLM_RETRY_JITTER,
} from "../model/streaming/streamModel.js";
import {
  DEFAULT_SUBAGENT_POLICY,
  ROUTER_PRICING_UNITS,
  type RouterConfig,
  type RouterModelRef,
} from "./config/schema.js";
import type {
  PilotDeckCustomRouter,
  CustomRouterRegistry,
} from "./customRouter/customRouter.js";
import { noopCustomRouterRegistry } from "./customRouter/customRouter.js";
import { isFallbackEligible, isProviderWideFailure } from "./fallback/isFallbackEligible.js";
import { assertContentSupported, type MediaValidationOptions } from "../model/protocol/multimodal.js";
import { compressImageToFit } from "../model/request/compressImage.js";
import { assertModelRequestCapabilities } from "../model/request/validateModelRequest.js";
import { applyOrchestration } from "./orchestrate/applyOrchestration.js";
import type {
  RouterDecision,
  RouterDecisionInput,
  RouterExecuteContext,
  RouterMutationsLog,
  RouterScenarioType,
} from "./protocol/decision.js";
import type { RouterEvent, RouterEventBus } from "./protocol/events.js";
import { decideScenario } from "./scenario/decideScenario.js";
import { stripSubagentTagFromMessages } from "./scenario/subagentDetector.js";
import { SessionRouterStore } from "./session/SessionRouterStore.js";
import { ProviderHealthTracker } from "./health/ProviderHealthTracker.js";
import {
  createZeroUsageState,
  observeEventForZeroUsage,
  shouldRetryZeroUsage,
} from "./retry/zeroUsageRetry.js";
import { TokenStatsCollector } from "./stats/TokenStatsCollector.js";
import { classifyAndRoute } from "./tokenSaver/classifyAndRoute.js";
import { countMessagesTokens, countResponseTokens, dispose as disposeTokenizer } from "./utils/countTokens.js";
import { lookupBuiltInModelPricing, orderPoolByConfiguredPrice } from "./utils/modelPricing.js";
import { collectRequiredInputModalities } from "./utils/mediaRequirements.js";
import type { TelemetryClient } from "../telemetry/index.js";
import { currentRequestContext } from "../network/requestContext.js";
import { buildCachePlan } from "../context/cache/CachePlan.js";

const STANDARD_TIERS = ["simple", "medium", "complex", "reasoning"];

type ResizedImages = Map<string, Map<string, Awaited<ReturnType<typeof compressImageToFit>>>>;
type MediaPreparation = { resizedImages: ResizedImages; signal?: AbortSignal };

export type RouterRuntimeDeps = {
  modelRuntime: ModelRuntime;
  modelPool?: readonly RouterModelRef[];
  judgeRuntime?: ModelRuntime;
  customRouterRegistry?: CustomRouterRegistry;
  /** Optional skill prompt loader for AutoOrchestrate; receives extension id, returns text. */
  loadSkillPrompt?: (extensionId: string) => Promise<string | undefined>;
  events?: RouterEventBus;
  telemetry?: TelemetryClient;
  now?: () => Date;
  /**
   * Externally-owned session store that survives config-reload cycles.
   * When provided, `shutdown()` will NOT clear it.
   */
  sessionStore?: SessionRouterStore;
};

export type InvalidateStickyResult = {
  previousTier?: string;
  previousProvider?: string;
  previousModel?: string;
  orchestrating: boolean;
};

export type RouterRuntime = {
  decide(input: RouterDecisionInput): Promise<RouterDecision>;
  execute(
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext,
  ): AsyncIterable<CanonicalModelEvent>;
  /** Convenience helper used by agent loop: decide + execute in one call. */
  stream(
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { sessionId: string; isMainAgent: boolean; previousTier?: string },
  ): AsyncIterable<CanonicalModelEvent>;
  materializeRequest(decision: RouterDecision, request: CanonicalModelRequest): CanonicalModelRequest;
  /**
   * Clear routing sticky (provider/model/tier) for a session while preserving
   * orchestration state.  Call at the start of each new user turn so the
   * judge re-classifies the fresh message instead of reusing a stale tier.
   */
  invalidateSticky(sessionId: string): InvalidateStickyResult;
  observeUsage(sessionId: string, usage: import("../model/index.js").CanonicalUsage | undefined): void;
  stats: TokenStatsCollector;
  shutdown(): Promise<void>;
};

export function createRouterRuntime(
  config: RouterConfig,
  deps: RouterRuntimeDeps,
): RouterRuntime {
  const enabled = config.enabled !== false;
  const modelPool = new Map((deps.modelPool ?? []).map(model => [model.id, model]));
  const orderedPool = orderPoolByConfiguredPrice([...modelPool.values()], config.stats?.modelPricing);
  const configuredTiers = config.tokenSaver?.enabled ? config.tokenSaver.tiers : {};
  const tierOrder = [...STANDARD_TIERS, ...Object.keys(configuredTiers).filter(tier => !STANDARD_TIERS.includes(tier))];
  const tiers = tierOrder.filter(tier => configuredTiers[tier] !== undefined);
  const assignedModels = new Set(tiers.map(tier => configuredTiers[tier].model.id));
  const stats = new TokenStatsCollector({
    ...config.stats,
    enabled: enabled && (config.stats?.enabled ?? false),
    baselineModel: config.stats?.baselineModel
      ?? (config.scenarios?.default
        ? { provider: config.scenarios.default.provider, model: config.scenarios.default.model }
        : undefined),
  });
  const externalStore = !!deps.sessionStore;
  const sessionStore = deps.sessionStore ?? new SessionRouterStore({
    now: () => (deps.now?.() ?? new Date()).getTime(),
  });
  const customRouters = deps.customRouterRegistry ?? noopCustomRouterRegistry;
  const judgeRuntime = deps.judgeRuntime ?? deps.modelRuntime;
  const events = deps.events ?? { emit: () => undefined };
  const telemetry = deps.telemetry;
  const healthTrackers = new Map<string, ProviderHealthTracker>();
  // Share resize results from decision through dispatch, without retaining images across calls.
  const resizedImagesByDecision = new WeakMap<RouterDecision, ResizedImages>();
  function getHealthTracker(sessionId: string): ProviderHealthTracker {
    let tracker = healthTrackers.get(sessionId);
    if (!tracker) {
      tracker = new ProviderHealthTracker();
      healthTrackers.set(sessionId, tracker);
    }
    return tracker;
  }

  function assertRequestCapabilities(ref: RouterModelRef, request: CanonicalModelRequest): void {
    if (!request.stream && !request.systemPrompt && !request.tools?.length) return;
    assertModelRequestCapabilities(request, deps.modelRuntime.getCapabilities(ref.provider, ref.model), ref.model);
  }

  function supportsRequestCapabilities(ref: RouterModelRef, request: CanonicalModelRequest): boolean {
    try {
      assertRequestCapabilities(ref, request);
      return true;
    } catch {
      return false;
    }
  }

  function supportsMedia(ref: RouterModelRef, request: CanonicalModelRequest, options?: MediaValidationOptions): boolean {
    if (collectRequiredInputModalities(request.messages).length === 0) return true;
    try {
      assertContentSupported(request.messages.flatMap(messageContent), deps.modelRuntime.getMultimodal(ref.provider, ref.model), options);
      return true;
    } catch {
      return false;
    }
  }

  async function mediaSupport(
    candidate: RouterModelRef,
    request: CanonicalModelRequest,
    media: MediaPreparation,
  ): Promise<"full" | "limited" | undefined> {
    if (media.signal?.aborted) return undefined;
    if (supportsMedia(candidate, request)) return "full";
    if (supportsMedia(candidate, request, { allowImageCountOverflow: true })) return "limited";
    if (!supportsMedia(candidate, request, { allowImageResize: true, allowImageCountOverflow: true })) return undefined;

    const prepared = await prepareMediaForAttempt(request, candidate, deps.modelRuntime, false, media);
    if (!supportsMedia(candidate, prepared.request)) return undefined;
    return prepared.omittedImages > 0 ? "limited" : "full";
  }

  async function mediaCandidates(candidates: RouterModelRef[], request: CanonicalModelRequest, media: MediaPreparation): Promise<RouterModelRef[]> {
    if (collectRequiredInputModalities(request.messages).length === 0) return candidates;
    const full: RouterModelRef[] = [];
    const limited: RouterModelRef[] = [];
    for (const candidate of candidates) {
      if (media.signal?.aborted) break;
      const support = await mediaSupport(candidate, request, media);
      if (support === "full") full.push(candidate);
      else if (support === "limited") limited.push(candidate);
    }
    return [...full, ...limited];
  }

  function availableInPool(ref: RouterModelRef): boolean {
    return deps.modelPool === undefined || modelPool.has(ref.id);
  }

  function eligibleTierModels(tier?: string): RouterModelRef[] {
    const start = tier === undefined ? 0 : Math.max(0, tiers.indexOf(tier));
    return tiers.slice(start).map(name => configuredTiers[name].model);
  }

  function canAttempt(ref: RouterModelRef, turnRouting: RouterExecuteContext["turnRouting"]): boolean {
    return !turnRouting?.failedModels.has(ref.id) && !turnRouting?.failedProviders.has(ref.provider);
  }

  async function candidateModels(
    decision: RouterDecision,
    ctx: Pick<RouterExecuteContext, "sessionId" | "turnRouting">,
    request: CanonicalModelRequest,
    media: MediaPreparation,
  ): Promise<{ native: RouterModelRef[]; withPlaceholders: RouterModelRef[] }> {
    const preferred = { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model };
    if (decision.scenarioType === "explicit") {
      return { native: [], withPlaceholders: supportsRequestCapabilities(preferred, request) ? [preferred] : [] };
    }

    const tierModels = eligibleTierModels(decision.tokenSaverTier);
    const eligibleIds = new Set(tierModels.map(model => model.id));
    const ordered = new Map([preferred, ...tierModels, ...orderedPool].map(model => [model.id, model]));
    const candidates = [...ordered.values()].filter(model =>
      (!assignedModels.has(model.id) || eligibleIds.has(model.id))
      && availableInPool(model) && canAttempt(model, ctx.turnRouting)
      && supportsRequestCapabilities(model, request)
    );
    const health = getHealthTracker(ctx.sessionId);
    const available: RouterModelRef[] = [];
    const open: RouterModelRef[] = [];
    for (const candidate of candidates) {
      (health.shouldSkip(candidate.provider) ? open : available).push(candidate);
    }
    const native = await mediaCandidates(available, request, media);
    if (native.length) return { native, withPlaceholders: available };

    // Probe a provider that can carry the media before falling back to placeholders.
    const [probe] = await mediaCandidates(open, request, media);
    return {
      native: probe ? [probe] : [],
      withPlaceholders: available.length ? available : (probe ? [probe] : open.slice(0, 1)),
    };
  }

  async function adjustDecisionForCompatibility(input: RouterDecisionInput, decision: RouterDecision, media: MediaPreparation): Promise<void> {
    const request = applyDecisionToRequest(decision, input.request);
    const { native, withPlaceholders } = await candidateModels(decision, input, request, media);
    const replacement = native[0] ?? withPlaceholders[0];
    if (!replacement || (replacement.provider === decision.provider && replacement.model === decision.model)) return;

    const required = collectRequiredInputModalities(request.messages);
    const selected = { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model };
    if (required.length && native[0] === replacement && !(await mediaSupport(selected, request, media))) {
      decision.mutations.mediaCapabilityRerouted = { required, from: selected.id, to: replacement.id };
    }
    decision.provider = replacement.provider;
    decision.model = replacement.model;
    decision.resolvedFrom = "fallback";
  }

  async function compareInputCosts(
    current: RouterModelRef | undefined,
    next: RouterModelRef,
    tier: string,
    request: CanonicalModelRequest,
    lastUsage: import("../model/index.js").CanonicalUsage | undefined,
    media: MediaPreparation,
  ): Promise<{ selection: RouterModelRef; mutation?: RouterMutationsLog["cacheAwareSwitch"] }> {
    if (!current) {
      return { selection: next };
    }
    if (current.provider === next.provider && current.model === next.model) {
      return { selection: next };
    }

    if (!eligibleTierModels(tier).some(model => model.id === current.id)
      || ![current, next].every(ref => availableInPool(ref) && supportsRequestCapabilities(ref, request))) {
      return { selection: next };
    }

    const pricing = config.stats?.modelPricing;
    const currentPricing = pricing?.[current.id] ?? lookupBuiltInModelPricing(current.provider, current.model);
    const nextPricing = pricing?.[next.id] ?? lookupBuiltInModelPricing(next.provider, next.model);
    const currentInput = currentPricing?.input;
    const nextInput = nextPricing?.input;
    const defaultUnit = ROUTER_PRICING_UNITS[0];
    if (currentInput === undefined || nextInput === undefined
      || !Number.isFinite(currentInput) || !Number.isFinite(nextInput)
      || (currentPricing?.unit ?? defaultUnit) !== (nextPricing?.unit ?? defaultUnit)) {
      return { selection: next };
    }

    const currentSupport = await mediaSupport(current, request, media);
    const nextSupport = await mediaSupport(next, request, media);
    if (!currentSupport || currentSupport !== nextSupport) {
      return { selection: next };
    }

    const estimatedInputTokens = countMessagesTokens(request.messages);
    const observedCacheReadTokens = lastUsage?.cacheReadTokens ?? 0;
    // Canonical inputTokens excludes cache reads and writes.
    const observedInputTokens = (lastUsage?.inputTokens ?? 0)
      + observedCacheReadTokens
      + (lastUsage?.cacheWriteTokens ?? 0);
    const observedCacheHitRatio = observedInputTokens > 0
      ? Math.min(1, Math.max(0, observedCacheReadTokens / observedInputTokens))
      : 0;
    const estimatedCacheReadTokens = Math.floor(estimatedInputTokens * observedCacheHitRatio);
    const estimatedUncachedTokens = Math.max(0, estimatedInputTokens - estimatedCacheReadTokens);
    const cachedCost = (estimatedCacheReadTokens / 1_000_000) * (currentPricing?.cacheRead ?? currentInput)
      + (estimatedUncachedTokens / 1_000_000) * currentInput;
    const prefillCost = (estimatedInputTokens / 1_000_000) * nextInput;

    const minSavingsRatio = config.tokenSaver?.cacheAwareSwitching?.minSavingsRatio ?? 0;
    const requiredSavings = cachedCost * minSavingsRatio;
    const shouldSwitch = prefillCost + Number.EPSILON < cachedCost - requiredSavings;
    const from = `${current.provider}/${current.model}`;
    const to = `${next.provider}/${next.model}`;

    if (shouldSwitch) {
      return {
        selection: next,
        mutation: {
          action: "switched",
          from,
          to,
          cachedCost,
          prefillCost,
          estimatedInputTokens,
        },
      };
    }

    return {
      selection: current,
      mutation: {
        action: "kept_sticky",
        from,
        to,
        cachedCost,
        prefillCost,
        estimatedInputTokens,
      },
    };
  }

  async function resolveCustom(
    input: RouterDecisionInput,
  ): Promise<Partial<RouterDecision> | undefined> {
    if (!config.customRouter) {
      return undefined;
    }
    const router: PilotDeckCustomRouter | undefined = customRouters.lookupRouter(
      config.customRouter.extensionId,
    );
    if (!router) {
      return undefined;
    }
    try {
      return await router.decide({
        ...input,
        context: {
          sessionId: input.sessionId,
          isMainAgent: input.isMainAgent,
          scenarios: Object.keys(config.scenarios ?? {}),
        },
      });
    } catch (error) {
      events.emit({
        type: "pilotdeck_router_custom_failed",
        sessionId: input.sessionId,
        extensionId: config.customRouter.extensionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async function decide(input: RouterDecisionInput): Promise<RouterDecision> {
    input.abortSignal?.throwIfAborted();
    if (!enabled) {
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: "default",
        isSubagent: !input.isMainAgent,
        orchestrating: false,
        resolvedFrom: "scenario",
        mutations: {},
      };
    }

    const isSubagent = !input.isMainAgent;
    const sticky = sessionStore.get(input.sessionId, isSubagent);
    const baseUsage = sticky?.lastUsage;
    const inputWithUsage: RouterDecisionInput = {
      ...input,
      metadata: {
        ...input.metadata,
        lastUsage: input.metadata?.lastUsage ?? {
          inputTokens: baseUsage?.inputTokens,
          outputTokens: baseUsage?.outputTokens,
          totalTokens: baseUsage?.totalTokens,
        },
      },
    };

    const scenarioOutcome = decideScenario(inputWithUsage, config.scenarios ?? {} as any);
    const custom = scenarioOutcome.scenarioType === "explicit" ? undefined : await resolveCustom(inputWithUsage);
    input.abortSignal?.throwIfAborted();

    let scenarioType: RouterScenarioType = scenarioOutcome.scenarioType;
    let selection: RouterModelRef | undefined =
      custom?.provider && custom.model
        ? { id: `${custom.provider}/${custom.model}`, provider: custom.provider, model: custom.model }
        : scenarioOutcome.selection;

    let resolvedFrom: RouterDecision["resolvedFrom"] = custom?.provider
      ? "custom"
      : scenarioType === "explicit"
        ? "explicit"
        : "scenario";

    let tokenSaverTier: string | undefined;
    let cacheAwareSwitch: RouterMutationsLog["cacheAwareSwitch"];
    const media: MediaPreparation = { resizedImages: new Map(), signal: input.abortSignal };
    const subagentPolicy = config.tokenSaver?.subagent?.policy ?? DEFAULT_SUBAGENT_POLICY;
    const previousCall = input.turnRouting?.continuationTarget;
    if (previousCall && !custom?.provider && scenarioType !== "explicit") {
      selection = {
        id: `${previousCall.provider}/${previousCall.model}`,
        provider: previousCall.provider,
        model: previousCall.model,
      };
      resolvedFrom = previousCall.resolvedFrom;
      tokenSaverTier = previousCall.tokenSaverTier;
    } else if (
      !custom?.provider &&
      scenarioType !== "explicit" &&
      config.tokenSaver?.enabled &&
      (input.isMainAgent || subagentPolicy !== "skip")
    ) {
      let stickyHit = false;
      // Request-only context (memory, date notices, artifact indexes) does not
      // turn a fresh user request into an ongoing conversation.
      const hasConversationHistory = input.request.messages.filter(message => message.metadata?.synthetic !== true).length > 1;

      if (input.isMainAgent && hasConversationHistory) {
        const mainSticky = sessionStore.get(input.sessionId, false);
        if (mainSticky?.stickyProvider && mainSticky.stickyModel) {
          selection = {
            id: `${mainSticky.stickyProvider}/${mainSticky.stickyModel}`,
            provider: mainSticky.stickyProvider,
            model: mainSticky.stickyModel,
          };
          resolvedFrom = "tokenSaver";
          tokenSaverTier = mainSticky.tokenSaverTier;
          stickyHit = true;
        }
      }

      if (!input.isMainAgent && subagentPolicy === "judge" && hasConversationHistory) {
        const subSticky = sessionStore.get(input.sessionId, true);
        if (subSticky?.stickyProvider && subSticky.stickyModel) {
          selection = {
            id: `${subSticky.stickyProvider}/${subSticky.stickyModel}`,
            provider: subSticky.stickyProvider,
            model: subSticky.stickyModel,
          };
          resolvedFrom = "tokenSaver";
          tokenSaverTier = subSticky.tokenSaverTier;
          stickyHit = true;
        }
      }

      if (!stickyHit) {
        const tokenSaver = await classifyAndRoute({
          config: config.tokenSaver,
          messages: input.request.messages,
          judgeRuntime,
          abortSignal: input.abortSignal,
          previousTier: input.metadata?.previousTier,
          sessionId: input.sessionId,
          telemetry,
        });
        if (tokenSaver) {
          if (tokenSaver.failureReason) {
            events.emit({
              type: "pilotdeck_router_token_saver_failed",
              sessionId: input.sessionId,
              reason: tokenSaver.failureReason,
              fallbackTier: tokenSaver.tier,
              judgeProvider: config.tokenSaver.judge.provider,
              judgeModel: config.tokenSaver.judge.model,
              attempts: tokenSaver.failure?.attempts ?? 1,
              ...(tokenSaver.failure?.code ? { errorCode: tokenSaver.failure.code } : {}),
              ...(tokenSaver.failure?.message ? { errorMessage: tokenSaver.failure.message } : {}),
            });
          }
          if (tokenSaver.selection) {
            selection = tokenSaver.selection;
            resolvedFrom = "tokenSaver";
            const previousExecution = sessionStore.get(input.sessionId, isSubagent)?.lastSuccessful;
            const cacheAware = await compareInputCosts(
              previousExecution?.target,
              selection,
              tokenSaver.tier,
              input.request,
              previousExecution?.usage,
              media,
            );
            selection = cacheAware.selection;
            cacheAwareSwitch = cacheAware.mutation;
          }
          tokenSaverTier = tokenSaver.tier;
        }
      }
    }

    if (!selection && scenarioOutcome.subagentModelHint) {
      const slash = scenarioOutcome.subagentModelHint.indexOf("/");
      if (slash >= 0) {
        const provider = scenarioOutcome.subagentModelHint.slice(0, slash);
        const model = scenarioOutcome.subagentModelHint.slice(slash + 1);
        if (provider && model) {
          selection = { id: scenarioOutcome.subagentModelHint, provider, model };
          resolvedFrom = "explicit";
        }
      }
    }

    if (!selection) {
      selection = config.scenarios?.default;
      scenarioType = scenarioType === "explicit" ? scenarioType : "default";
    }

    if (!selection) {
      throw new Error("Router: no default scenario configured and no model could be resolved");
    }

    const decision: RouterDecision = {
      provider: selection.provider,
      model: selection.model,
      scenarioType,
      tokenSaverTier,
      isSubagent: scenarioOutcome.isSubagent,
      orchestrating: false,
      resolvedFrom,
      mutations: {},
    };

    const alreadyOrchestrating = sticky?.orchestrating === true;
    const tokenSaverActive = config.tokenSaver?.enabled === true && tokenSaverTier != null;
    const orchGate = tokenSaverActive || alreadyOrchestrating;
    console.log(
      `[router] decision: tier=${tokenSaverTier}, model=${selection.provider}/${selection.model}, orchGate=${orchGate}, alreadyOrch=${alreadyOrchestrating}, resolvedFrom=${resolvedFrom}`,
    );

    let mutations: RouterMutationsLog = {};
    if (cacheAwareSwitch) {
      mutations = { ...mutations, cacheAwareSwitch };
    }
    if (config.autoOrchestrate?.enabled && orchGate) {
      const orchestrated = applyOrchestration({
        config: config.autoOrchestrate,
        isMainAgent: input.isMainAgent,
        tier: tokenSaverTier,
        alreadyOrchestrating,
      });
      if (orchestrated.applied) {
        mutations = { ...mutations, ...orchestrated.mutations };
        decision.orchestrating = true;
      }
    }

    if (scenarioOutcome.subagentModelHint || decision.isSubagent) {
      mutations = { ...mutations, subagentTagStripped: true };
    }

    decision.mutations = mutations;
    await adjustDecisionForCompatibility(input, decision, media);

    input.abortSignal?.throwIfAborted();
    resizedImagesByDecision.set(decision, media.resizedImages);

    sessionStore.set({
      ...sessionStore.get(input.sessionId, isSubagent),
      sessionId: input.sessionId,
      isSubagent,
      tokenSaverTier,
      stickyProvider: decision.provider,
      stickyModel: decision.model,
      orchestrating: decision.orchestrating,
      updatedAt: (deps.now?.() ?? new Date()).getTime(),
    });

    events.emit({
      type: "pilotdeck_router_decision",
      sessionId: input.sessionId,
      decision,
    });

    return decision;
  }

  function applyDecisionToRequest(
    decision: RouterDecision,
    request: CanonicalModelRequest,
  ): CanonicalModelRequest {
    let messages = decision.requestPatch?.messages ?? request.messages;
    if (decision.mutations.subagentTagStripped) {
      messages = stripSubagentTagFromMessages(messages);
    }
    const routedCachePlan = request.cachePlan &&
      (request.cachePlan.provider === undefined || request.cachePlan.provider === decision.provider) &&
      (request.cachePlan.model === undefined || request.cachePlan.model === decision.model)
      ? request.cachePlan
      : undefined;
    const finalized = {
      ...request,
      ...decision.requestPatch,
      provider: decision.provider,
      model: decision.model,
      messages,
      cacheBreakpoints: request.cachePlan !== undefined
        ? routedCachePlan?.messages
        : request.cacheBreakpoints,
      cachePlan: routedCachePlan,
    };
    if (routedCachePlan && (messages !== request.messages || finalized.systemPrompt !== request.systemPrompt || finalized.tools !== request.tools)) {
      finalized.cachePlan = buildCachePlan({ ...finalized, tools: finalized.tools ?? [], enabled: true }, routedCachePlan.generation);
      finalized.cacheBreakpoints = finalized.cachePlan?.messages;
    }
    return clampMaxOutputTokensToModelCap(finalized, deps.modelRuntime);
  }

  async function* execute(
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext,
  ): AsyncIterable<CanonicalModelEvent> {
    const media: MediaPreparation = { resizedImages: resizedImagesByDecision.get(decision) ?? new Map(), signal: ctx.abortSignal };
    resizedImagesByDecision.delete(decision);
    if (!enabled) {
      if (ctx.abortSignal?.aborted) return;
      request = await ctx.requestForTarget?.(decision) ?? request;
      const routedCachePlan = request.cachePlan &&
        (request.cachePlan.provider === undefined || request.cachePlan.provider === decision.provider) &&
        (request.cachePlan.model === undefined || request.cachePlan.model === decision.model)
        ? request.cachePlan
        : undefined;
      const passthroughRequest: CanonicalModelRequest = {
        ...request,
        provider: decision.provider,
        model: decision.model,
        cacheBreakpoints: request.cachePlan !== undefined
          ? routedCachePlan?.messages
          : request.cacheBreakpoints,
        cachePlan: routedCachePlan,
      };
      const { request: mediaRequest, omittedImages } = await prepareMediaForAttempt(
        passthroughRequest,
        { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model },
        deps.modelRuntime,
        true,
        media,
      );
      const cappedPassthroughRequest = clampMaxOutputTokensToModelCap(mediaRequest, deps.modelRuntime);
      await ctx.onRequestPrepared?.(cappedPassthroughRequest, omittedImages);
      if (ctx.abortSignal?.aborted) return;
      let sawErrorEvent = false;
      for await (const item of streamAttempt(cappedPassthroughRequest, deps.modelRuntime, ctx, events)) {
        if (item.kind === "event") {
          if (item.event.type === "error") {
            sawErrorEvent = true;
          }
          yield item.event;
          continue;
        }
        if (item.outcome.error && !sawErrorEvent) {
          yield { type: "error", error: item.outcome.error };
        }
      }
      return;
    }

    const startedAt = (deps.now?.() ?? new Date()).toISOString();
    const isSubagent = ctx.isMainAgent === undefined ? decision.isSubagent : !ctx.isMainAgent;
    const executionState = sessionStore.get(ctx.sessionId, isSubagent);
    const baseRequest = applyDecisionToRequest(decision, request);
    const turnRouting = ctx.turnRouting ?? { failedModels: new Set<string>(), failedProviders: new Set<string>() };
    const attemptContext = { sessionId: ctx.sessionId, turnRouting };
    const explicit = decision.scenarioType === "explicit";
    const { native: nativeCandidates, withPlaceholders } = await candidateModels(decision, attemptContext, baseRequest, media);
    // If all native projections fail before dispatch, retry preparation with placeholders.
    const attempts = [...nativeCandidates, ...withPlaceholders];
    const zeroUsageMax = Math.max(1, config.zeroUsageRetry?.maxAttempts ?? 5);
    const zeroUsageEnabled = config.zeroUsageRetry?.enabled ?? true;
    const transientRetryEnabled = config.transientRetry?.enabled ?? true;
    const transientRetryMax = Math.max(1, config.transientRetry?.maxAttempts ?? LITELLM_DEFAULT_MAX_RETRIES);
    const transientBaseDelayMs = config.transientRetry?.baseDelayMs ?? LITELLM_INITIAL_RETRY_DELAY_MS;
    const transientMaxDelayMs = config.transientRetry?.maxDelayMs ?? LITELLM_MAX_RETRY_DELAY_MS;

    let lastBuffered: CanonicalModelEvent[] = [];
    let lastError: import("../model/index.js").CanonicalModelError | undefined;
    let lastUsage: import("../model/index.js").CanonicalUsage | undefined;
    let lastAttempt: RouterModelRef | undefined;
    let lastDecision: RouterDecision = decision;
    let lastHasYieldedContent = false;

    let attemptsStarted = 0;
    let dispatchedNative = false;
    let previousFailure: import("../model/index.js").CanonicalModelError | undefined;
    let projectionError: import("../model/index.js").CanonicalModelError | undefined;

    outer: for (const [attemptIndex, attempt] of attempts.entries()) {
      if (ctx.abortSignal?.aborted) return;
      if (attemptsStarted >= MAX_MODEL_ATTEMPTS) break;
      const allowPlaceholders = attemptIndex >= nativeCandidates.length;
      if (allowPlaceholders && dispatchedNative) break;
      if (!explicit && !canAttempt(attempt, turnRouting)) continue;
      const attemptDecision: RouterDecision = {
        ...decision,
        provider: attempt.provider,
        model: attempt.model,
        resolvedFrom: attempt.provider === decision.provider && attempt.model === decision.model
          ? decision.resolvedFrom
          : "fallback",
      };
      const targetRequest = await ctx.requestForTarget?.(attemptDecision) ?? request;
      if (ctx.abortSignal?.aborted) return;
      const projected = applyDecisionToRequest(attemptDecision, targetRequest);
      const { request: attemptRequest, omittedImages } = await prepareMediaForAttempt(
        projected, attempt, deps.modelRuntime, allowPlaceholders, media,
      );
      if (ctx.abortSignal?.aborted) return;
      if (!supportsRequestCapabilities(attempt, attemptRequest) || !supportsMedia(attempt, attemptRequest)) {
        projectionError = incompatibleRequestError(attempt, attemptRequest);
        continue;
      }
      await ctx.onRequestPrepared?.(attemptRequest, omittedImages);
      if (ctx.abortSignal?.aborted) return;

      if (lastAttempt && previousFailure) {
        events.emit({
          type: "pilotdeck_router_fallback",
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          scenarioType: attemptDecision.scenarioType,
          attempt: attemptsStarted,
          fromProvider: lastAttempt.provider,
          fromModel: lastAttempt.model,
          toProvider: attempt.provider,
          toModel: attempt.model,
          error: previousFailure,
        });
        telemetry?.trackFeatureLoopStage({
          module: "router",
          ownerModule: "router",
          phase: "fallback",
          loopStage: "module_event",
          outcome: "success",
          sessionId: ctx.sessionId,
          metadata: {
            event: "fallback_attempt",
            scenarioType: attemptDecision.scenarioType,
            attempt: attemptsStarted,
            fromProvider: lastAttempt.provider,
            fromModel: lastAttempt.model,
            toProvider: attempt.provider,
            toModel: attempt.model,
            errorCode: previousFailure.code,
          },
        });
      }
      previousFailure = undefined;
      attemptsStarted++;
      dispatchedNative ||= !allowPlaceholders;
      lastAttempt = attempt;
      lastDecision = attemptDecision;

      if (decision.isSubagent && config.autoOrchestrate?.subagentMaxTokens) {
        const budget = config.autoOrchestrate.subagentMaxTokens;
        const estimated = countMessagesTokens(attemptRequest.messages);
        if (estimated > budget) {
          yield {
            type: "error",
            error: {
              provider: attempt.provider,
              protocol: protocolForProvider(deps.modelRuntime, attempt.provider),
              code: "subagent_budget_exceeded",
              message: `Sub-agent budget exceeded (${estimated} estimated tokens > ${budget} limit).`,
              retryable: false,
              userHint: "Reduce the subagent prompt/context, increase the subagent token budget, or split the task into smaller steps.",
            },
          } as CanonicalModelEvent;
          return;
        }
      }

      let zeroUsageAttempt = 0;
      let transientRetryCount = 0;
      while (true) {
        zeroUsageAttempt += 1;
        // Live-stream events. We track whether we've already surfaced any
        // content event (text/thinking/tool) to the consumer; once we have,
        // fallback / retry is no longer safe (would duplicate text).
        let hasYieldedContent = false;
        const pending: CanonicalModelEvent[] = [];
        let outcome: AttemptOutcome | undefined;

        for await (const item of streamAttempt(attemptRequest, deps.modelRuntime, ctx, events)) {
          if (item.kind === "outcome") {
            outcome = item.outcome;
            break;
          }
          const event = item.event;
          if (!hasYieldedContent && isContentEvent(event)) {
            // Flush any framing events queued before the first content delta
            // (request_started / message_start) and the content event itself.
            for (const queued of pending) {
              yield queued;
            }
            pending.length = 0;
            yield event;
            hasYieldedContent = true;
            continue;
          }
          if (hasYieldedContent) {
            yield event;
            continue;
          }
          // Pre-content phase: defer framing events; we may need to swallow
          // them and replay from a fallback attempt.
          pending.push(event);
        }

        if (ctx.abortSignal?.aborted) return;
        if (!outcome) {
          lastHasYieldedContent = hasYieldedContent;
          break outer;
        }

        lastBuffered = outcome.buffered;
        lastUsage = outcome.usage;

        if (outcome.error) {
          lastError = outcome.error;
          const providerWide = isProviderWideFailure(outcome.error);
          if (providerWide) getHealthTracker(ctx.sessionId).recordFailure(attempt.provider);
          if (
            !hasYieldedContent && isFallbackEligible(outcome.error)
            && attemptsStarted < MAX_MODEL_ATTEMPTS
            && attempts.slice(attemptIndex + 1, allowPlaceholders ? attempts.length : nativeCandidates.length).some(next =>
              (!providerWide || next.provider !== attempt.provider) && canAttempt(next, turnRouting)
            )
          ) {
            if (providerWide) turnRouting.failedProviders.add(attempt.provider);
            else turnRouting.failedModels.add(attempt.id);
            previousFailure = outcome.error;
            continue outer;
          }
          if (
            !hasYieldedContent &&
            isFallbackEligible(outcome.error) &&
            transientRetryEnabled &&
            transientRetryCount < transientRetryMax
          ) {
            const delay = outcome.error.retryAfterMs != null
              ? Math.min(outcome.error.retryAfterMs, transientMaxDelayMs)
              : calculateLiteLLMRetryDelay(transientRetryCount, transientBaseDelayMs, transientMaxDelayMs);
            console.warn(
              `[PilotDeck] transientRetry: ${outcome.error.code} (attempt ${transientRetryCount + 1}/${transientRetryMax}, delay=${Math.round(delay)}ms)`,
            );
            events.emit({
              type: "pilotdeck_router_transient_retry",
              sessionId: ctx.sessionId,
              turnId: ctx.turnId,
              attempt: transientRetryCount + 1,
              delayMs: Math.round(delay),
              provider: attempt.provider,
              model: attempt.model,
              errorCode: outcome.error.code,
            });
            events.emit({
              type: "pilotdeck_router_retry_progress",
              sessionId: ctx.sessionId,
              turnId: ctx.turnId,
              attempt: transientRetryCount + 1,
              maxAttempts: transientRetryMax,
              delayMs: Math.round(delay),
              reason: classifyRetryReason(outcome.error.code),
              provider: attempt.provider,
              model: attempt.model,
            });
            telemetry?.trackFeatureLoopStage({
              module: "router",
              ownerModule: "router",
              phase: "fallback",
              loopStage: "module_event",
              outcome: "success",
              sessionId: ctx.sessionId,
              metadata: {
                event: "transient_retry",
                attempt: transientRetryCount + 1,
                delayMs: Math.round(delay),
                provider: attempt.provider,
                model: attempt.model,
                errorCode: outcome.error.code,
              },
            });
            await abortableDelay(delay, ctx.abortSignal);
            transientRetryCount++;
            continue;
          }
          for (const queued of pending) {
            yield queued;
          }
          lastHasYieldedContent = hasYieldedContent;
          break outer;
        }

        if (
          !hasYieldedContent &&
          zeroUsageEnabled &&
          outcome.shouldRetryZeroUsage &&
          zeroUsageAttempt < zeroUsageMax
        ) {
          console.warn(
            `[PilotDeck] zeroUsageRetry: empty response from ${attempt.provider}/${attempt.model} ` +
            `(attempt ${zeroUsageAttempt}/${zeroUsageMax}, session=${ctx.sessionId})`,
          );
          events.emit({
            type: "pilotdeck_router_zero_usage_retry",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            attempt: zeroUsageAttempt,
            provider: attempt.provider,
            model: attempt.model,
          });
          events.emit({
            type: "pilotdeck_router_retry_progress",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            attempt: zeroUsageAttempt,
            maxAttempts: zeroUsageMax,
            delayMs: 500 * zeroUsageAttempt,
            reason: "zero_usage",
            provider: attempt.provider,
            model: attempt.model,
          });
          telemetry?.trackFeatureLoopStage({
            module: "router",
            ownerModule: "router",
            phase: "fallback",
            loopStage: "module_event",
            outcome: "success",
            sessionId: ctx.sessionId,
            metadata: {
              event: "zero_usage_retry",
              attempt: zeroUsageAttempt,
              provider: attempt.provider,
              model: attempt.model,
            },
          });
          await abortableDelay(500 * zeroUsageAttempt, ctx.abortSignal);
          continue;
        }

        getHealthTracker(ctx.sessionId).recordSuccess(attempt.provider);

        const endedAt = (deps.now?.() ?? new Date()).toISOString();
        let finalUsage = outcome.usage;
        if (!finalUsage || (!finalUsage.inputTokens && !finalUsage.outputTokens)) {
          const inputEst = countMessagesTokens(attemptRequest.messages);
          const outputEst = countResponseTokens(outcome.buffered);
          finalUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
        }
        const ending = outcome.buffered.find(event => event.type === "message_end");
        const producedOutput = outcome.buffered.some(event =>
          event.type === "tool_call_end" || (event.type === "text_delta" && event.text.trim().length > 0)
        );
        if (ending && producedOutput && ctx.turnRouting) ctx.turnRouting.continuationTarget = attemptDecision;
        if ((ending?.finishReason === "stop" || ending?.finishReason === "tool_call") && producedOutput) {
          const current = sessionStore.get(ctx.sessionId, isSubagent);
          // Update the route selected for this call when it still owns the sticky
          // slot. A manual selection or a newer decision owns its own route.
          const ownsSticky = decision.scenarioType !== "explicit" && current !== undefined && current === executionState
            && current.stickyProvider === decision.provider && current.stickyModel === decision.model;
          sessionStore.set({
            ...current,
            sessionId: ctx.sessionId,
            isSubagent,
            orchestrating: current?.orchestrating ?? false,
            ...(ownsSticky ? { stickyProvider: attempt.provider, stickyModel: attempt.model } : {}),
            lastSuccessful: { target: attempt, usage: outcome.usage },
            lastUsage: finalUsage,
            updatedAt: (deps.now?.() ?? new Date()).getTime(),
          });
        }

        if (!hasYieldedContent) {
          for (const queued of pending) {
            yield queued;
          }
        }

        stats.observe({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          projectPath: ctx.projectPath,
          scenarioType: attemptDecision.scenarioType,
          resolvedFrom: attemptDecision.resolvedFrom,
          provider: attempt.provider,
          model: attempt.model,
          tier: decision.tokenSaverTier,
          role: decision.isSubagent ? "subagent" : "main",
          usage: finalUsage,
          startedAt,
          endedAt,
        });
        return;
      }
    }

    if (lastError && lastAttempt) {
      events.emit({
        type: "pilotdeck_router_execute_failed",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        scenarioType: lastDecision.scenarioType,
        provider: lastAttempt.provider,
        model: lastAttempt.model,
        error: lastError,
      });
      const endedAt = (deps.now?.() ?? new Date()).toISOString();
      let failUsage = lastUsage;
      if (!failUsage || (!failUsage.inputTokens && !failUsage.outputTokens)) {
        const inputEst = countMessagesTokens(request.messages);
        const outputEst = countResponseTokens(lastBuffered);
        failUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
      }
      stats.observe({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        projectPath: ctx.projectPath,
        scenarioType: lastDecision.scenarioType,
        resolvedFrom: lastDecision.resolvedFrom,
        provider: lastAttempt.provider,
        model: lastAttempt.model,
        tier: decision.tokenSaverTier,
        role: decision.isSubagent ? "subagent" : "main",
        usage: failUsage,
        startedAt,
        endedAt,
      });
      if (!lastHasYieldedContent) {
        for (const event of lastBuffered) {
          if (event.type !== "error") {
            yield event;
          }
        }
      }
      yield { type: "error", error: { ...lastError, provider: lastAttempt.provider, model: lastAttempt.model } };
    } else if (!ctx.abortSignal?.aborted) {
      const target = { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model };
      const error = projectionError ?? incompatibleRequestError(target, baseRequest);
      events.emit({
        type: "pilotdeck_router_execute_failed",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        scenarioType: decision.scenarioType,
        provider: error.provider,
        model: error.model ?? target.model,
        error,
      });
      yield { type: "error", error };
    }
  }

  function incompatibleRequestError(
    target: RouterModelRef,
    request: CanonicalModelRequest,
  ): import("../model/index.js").CanonicalModelError {
    const error = {
      provider: target.provider,
      model: target.model,
      protocol: protocolForProvider(deps.modelRuntime, target.provider),
      retryable: false,
    };
    try {
      assertRequestCapabilities(target, request);
      assertContentSupported(request.messages.flatMap(messageContent), deps.modelRuntime.getMultimodal(target.provider, target.model));
    } catch (cause) {
      if (cause instanceof ModelRequestError) return { ...error, code: cause.code, message: cause.message };
      throw cause;
    }
    return { ...error, code: "no_available_model", message: "No available model in the configured pool can handle this request." };
  }

  async function* stream(
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { sessionId: string; isMainAgent: boolean; previousTier?: string },
  ): AsyncIterable<CanonicalModelEvent> {
    const decision = await decide({
      request,
      sessionId: ctx.sessionId,
      isMainAgent: ctx.isMainAgent,
      abortSignal: ctx.abortSignal,
      turnRouting: ctx.turnRouting,
      metadata: ctx.previousTier ? { previousTier: ctx.previousTier } : undefined,
    });
    yield* execute(decision, request, ctx);
  }

  function invalidateSticky(sessionId: string): InvalidateStickyResult {
    if (!enabled) {
      return { orchestrating: false };
    }

    const current = sessionStore.get(sessionId, false);
    if (!current) return { orchestrating: false };

    const { tokenSaverTier: previousTier, orchestrating } = current;
    const previousTarget = current.lastSuccessful?.target;
    if (!orchestrating || !previousTier) {
      sessionStore.set({
        ...current,
        tokenSaverTier: undefined,
        stickyProvider: undefined,
        stickyModel: undefined,
        updatedAt: (deps.now?.() ?? new Date()).getTime(),
      });
    }
    return { previousTier, previousProvider: previousTarget?.provider, previousModel: previousTarget?.model, orchestrating };
  }

  return {
    decide,
    execute,
    stream,
    materializeRequest: applyDecisionToRequest,
    invalidateSticky,
    observeUsage(sessionId, usage) {
      if (!enabled || !usage) return;
      const current = sessionStore.get(sessionId, false);
      sessionStore.set({
        ...current,
        sessionId,
        isSubagent: false,
        orchestrating: current?.orchestrating ?? false,
        lastUsage: usage,
        updatedAt: (deps.now?.() ?? new Date()).getTime(),
      });
    },
    stats,
    async shutdown() {
      await stats.flush();
      stats.dispose();
      disposeTokenizer();
      if (!externalStore) sessionStore.clear();
      healthTrackers.clear();
    },
  };
}

const MAX_MODEL_ATTEMPTS = 6;

type AttemptOutcome = {
  buffered: CanonicalModelEvent[];
  error?: import("../model/index.js").CanonicalModelError;
  usage?: import("../model/index.js").CanonicalUsage;
  shouldRetryZeroUsage: boolean;
};

/**
 * "Content" events are the ones that are visible to the end-user / agent
 * loop in a way that can't be retracted: text, thinking, and tool-call
 * material. Once we've yielded any of these to the consumer, fallback /
 * retry would produce duplicates, so we lock in the current attempt.
 */
function isContentEvent(event: CanonicalModelEvent): boolean {
  return (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "tool_call_start" ||
    event.type === "tool_call_delta" ||
    event.type === "tool_call_end"
  );
}

function clampMaxOutputTokensToModelCap(
  request: CanonicalModelRequest,
  modelRuntime: ModelRuntime,
): CanonicalModelRequest {
  const requested = request.maxOutputTokens;
  if (requested === undefined) {
    return request;
  }

  try {
    const cap = modelRuntime.getCapabilities(request.provider, request.model).maxOutputTokens;
    if (Number.isFinite(cap) && cap > 0 && requested > cap) {
      return { ...request, maxOutputTokens: cap };
    }
  } catch {
    // Unknown provider/model — let validateModelRequest surface the real error.
  }
  return request;
}

async function prepareMediaForAttempt(
  request: CanonicalModelRequest,
  attempt: RouterModelRef,
  modelRuntime: ModelRuntime,
  allowPlaceholders: boolean,
  { resizedImages, signal }: MediaPreparation,
): Promise<{ request: CanonicalModelRequest; omittedImages: number }> {
  const modalities = collectRequiredInputModalities(request.messages);
  if (modalities.length === 0) return { request, omittedImages: 0 };

  let multimodal: ReturnType<ModelRuntime["getMultimodal"]>;
  try {
    multimodal = modelRuntime.getMultimodal(attempt.provider, attempt.model);
  } catch {
    // Unknown provider/model should still be reported by validateModelRequest.
    return { request, omittedImages: 0 };
  }
  const supportsImages = modalities.includes("image") && multimodal.input.includes("image");
  const detail = supportsImages ? multimodal.imageDetail : undefined;
  const maxImageBytes = supportsImages ? multimodal.maxImageBytes : undefined;
  const limitImageCount = supportsImages && multimodal.maxImagesPerRequest !== undefined;
  if (!detail && !maxImageBytes && !limitImageCount && !allowPlaceholders) return { request, omittedImages: 0 };

  const messages = cloneMessages(request.messages);
  let changed = false;
  if (detail || maxImageBytes) {
    for (const message of messages) {
      for (const block of message.content) {
        const parts = block.type === "tool_result" ? block.content : [block];
        for (const part of parts) {
          if (signal?.aborted) return { request, omittedImages: 0 };
          if (part.type !== "image") continue;
          if (maxImageBytes && part.source === "base64" && part.bytes && part.bytes > maxImageBytes) {
            let results = resizedImages.get(part.data);
            if (!results) {
              results = new Map();
              resizedImages.set(part.data, results);
            }
            const key = `${part.mimeType}:${maxImageBytes}`;
            if (!results.has(key)) {
              results.set(key, await compressImageToFit(Buffer.from(part.data, "base64"), part.mimeType, maxImageBytes));
            }
            const fitted = results.get(key);
            if (fitted && (!multimodal.supportedImageMimeTypes || multimodal.supportedImageMimeTypes.includes(fitted.mimeType))) {
              part.data = fitted.buffer.toString("base64");
              part.mimeType = fitted.mimeType;
              part.bytes = fitted.buffer.length;
              changed = true;
            }
          }
          if (detail && part.detail === undefined) {
            part.detail = detail;
            changed = true;
          }
        }
      }
    }
  }
  const downgrade = allowPlaceholders || limitImageCount
    ? downgradeUnsupportedContent(messages, multimodal, !allowPlaceholders)
    : { changed: false, omittedImages: 0 };

  return {
    request: changed || downgrade.changed ? refreshCachePlan({ ...request, messages }) : request,
    omittedImages: downgrade.omittedImages,
  };
}

function refreshCachePlan(request: CanonicalModelRequest): CanonicalModelRequest {
  if (!request.cachePlan) return request;
  const cachePlan = buildCachePlan({ ...request, tools: request.tools ?? [], enabled: true }, request.cachePlan.generation);
  return { ...request, cachePlan, cacheBreakpoints: cachePlan?.messages };
}

/**
 * Live attempt — yields each model event the moment it arrives, then yields
 * a final `{ outcome }` sentinel with retry/usage metadata. The previous
 * implementation `await`-ed the entire stream into `buffered[]` before
 * returning, which silently broke streaming UX (TUI/CLI saw the assistant
 * text appear in one burst at the end of the turn).
 *
 * Trade-off: zero-usage retry and provider fallback can only fire BEFORE we
 * yield any content. If a provider crashes mid-stream after we've already
 * surfaced text, we can't transparently fall back without leaking duplicate
 * text. This matches OpenAI's / Anthropic's own clients.
 */
async function* streamAttempt(
  request: CanonicalModelRequest,
  modelRuntime: ModelRuntime,
  ctx: RouterExecuteContext,
  events: RouterEventBus,
): AsyncGenerator<
  | { kind: "event"; event: CanonicalModelEvent }
  | { kind: "outcome"; outcome: AttemptOutcome }
> {
  const buffered: CanonicalModelEvent[] = [];
  const state = createZeroUsageState();
  let providerError: import("../model/index.js").CanonicalModelError | undefined;
  const abortSignal = ctx.abortSignal;

  try {
    for await (const event of modelRuntime.stream(request, {
      signal: abortSignal,
      requestContext: {
        sessionId: ctx.sessionId,
        // "compact" is an internal routing marker, not a user turn identity.
        // Manual compaction outside a turn intentionally has no turn header.
        turnId: ctx.turnId === "compact" ? currentRequestContext().turnId : ctx.turnId,
        projectPath: ctx.projectPath,
        purpose: ctx.turnId === "compact" ? "compaction" : "conversation",
      },
      onRetryProgress(progress) {
        events.emit({
          type: "pilotdeck_router_retry_progress",
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          attempt: progress.attempt,
          maxAttempts: progress.maxAttempts,
          delayMs: progress.delayMs,
          reason: progress.reason,
          provider: progress.provider,
          model: progress.model,
        });
      },
    })) {
      if (abortSignal?.aborted) {
        throwAbortError(abortSignal.reason);
      }
      observeEventForZeroUsage(state, event);
      buffered.push(event);
      if (event.type === "error") {
        providerError = event.error;
      }
      yield { kind: "event", event };
    }
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const fromError = (error as { error?: import("../model/index.js").CanonicalModelError })?.error;
    const protocol = protocolForProvider(modelRuntime, request.provider);
    providerError = fromError ?? canonicalizeModelRequestError(error, request, protocol) ?? {
      provider: request.provider,
      protocol,
      ...classifyNetworkError(error),
    };
  }

  yield {
    kind: "outcome",
    outcome: {
      buffered,
      error: providerError,
      usage: state.observedUsage,
      shouldRetryZeroUsage: shouldRetryZeroUsage(state),
    },
  };
}

function canonicalizeModelRequestError(
  error: unknown,
  request: CanonicalModelRequest,
  protocol: ModelProtocol,
): import("../model/index.js").CanonicalModelError | undefined {
  if (!(error instanceof ModelRequestError)) {
    return undefined;
  }

  return {
    provider: request.provider,
    protocol,
    code: error.code,
    message: error.message,
    retryable: false,
    raw: error.details,
  };
}

function protocolForProvider(modelRuntime: ModelRuntime, providerId: string): ModelProtocol {
  try {
    return modelRuntime.getProviderProtocol(providerId) ?? "openai";
  } catch {
    return "openai";
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    throwAbortError(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwAbortError(reason?: unknown): never {
  throw createAbortError(reason);
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const message = typeof reason === "string" && reason ? reason : "Operation aborted.";
  return new DOMException(message, "AbortError");
}

function isNetworkTransient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("epipe") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("dns") ||
    msg.includes("fetch failed") ||
    msg.includes("abort") ||
    error.name === "TimeoutError" ||
    error.name === "AbortError"
  );
}

function classifyNetworkError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (!(error instanceof Error)) return { code: "unknown", message: String(error), retryable: false };
  const message = error.message;
  const cause = (error.cause ?? error) as { code?: string };
  if (cause.code === "ENOTFOUND" || cause.code === "EAI_AGAIN") return { code: "dns_error", message, retryable: true };
  if (cause.code === "ECONNREFUSED") return { code: "connection_refused", message, retryable: true };

  const normalized = message.toLowerCase();
  if (error.name === "AbortError" || normalized.includes("abort")) return { code: "aborted", message, retryable: false };
  const code = error.name === "TimeoutError" || normalized.includes("timeout") ? "timeout" : "network_error";
  return { code, message, retryable: isNetworkTransient(error) };
}

function classifyRetryReason(errorCode: string): "rate_limit" | "server_error" | "network_error" | "zero_usage" | "overloaded" {
  if (errorCode === "rate_limit_error") return "rate_limit";
  if (errorCode === "overloaded_error") return "overloaded";
  if (errorCode === "server_error") return "server_error";
  if (["network_error", "dns_error", "connection_refused", "tls_error", "proxy_error", "timeout"].includes(errorCode)) {
    return "network_error";
  }
  return "server_error";
}

function calculateLiteLLMRetryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const deterministicDelay = baseDelayMs * (attempt + 1);
  const jitterDelay = deterministicDelay * LITELLM_RETRY_JITTER * Math.random();
  return Math.min(deterministicDelay + jitterDelay, maxDelayMs);
}
