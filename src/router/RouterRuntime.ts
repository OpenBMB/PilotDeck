import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CachePlan,
  ModelRuntimeOptions,
  ModelRuntime,
  ModelProtocol,
  ProviderAttemptEvent,
} from "../model/index.js";
import { cloneMessages, downgradeUnsupportedContent, ModelRequestError } from "../model/index.js";
import { rebuildRoutedCachePlan } from "../context/cache/CachePlan.js";
import type { InputModality } from "../model/index.js";
import {
  LITELLM_DEFAULT_MAX_RETRIES,
  LITELLM_INITIAL_RETRY_DELAY_MS,
  LITELLM_MAX_RETRY_DELAY_MS,
  LITELLM_RETRY_JITTER,
} from "../model/streaming/streamModel.js";
import {
  DEFAULT_SUBAGENT_POLICY,
  type RouterConfig,
  type RouterModelRef,
} from "./config/schema.js";
import type {
  PilotDeckCustomRouter,
  CustomRouterRegistry,
} from "./customRouter/customRouter.js";
import { noopCustomRouterRegistry } from "./customRouter/customRouter.js";
import { isFallbackEligible, planFallback } from "./fallback/runFallbackChain.js";
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
import { SessionUsageCache } from "./session/sessionUsageCache.js";
import {
  classifyRecoverySignal,
  providerFailureDomain,
  ProviderHealthTracker,
} from "./health/ProviderHealthTracker.js";
import {
  createZeroUsageState,
  observeEventForZeroUsage,
  shouldRetryZeroUsage,
} from "./retry/zeroUsageRetry.js";
import { TokenStatsCollector } from "./stats/TokenStatsCollector.js";
import {
  classifyAndRoute,
  type TokenSaverRoutingDiagnostics,
} from "./tokenSaver/classifyAndRoute.js";
import {
  countMessagesTokens,
  countResponseTokens,
  dispose as disposeTokenizer,
  estimateRequestInputTokens,
} from "./utils/countTokens.js";
import {
  calculateCacheReadCost,
  calculateInputCost,
  type RouterModelPricingMap,
} from "./utils/modelPricing.js";
import { compareStayVsSwitch, DEFAULT_CACHE_TTL_MS } from "./cost/switchCostEstimator.js";
import {
  collectRequiredInputModalities,
  missingInputModalities,
} from "./utils/mediaRequirements.js";
import type { TelemetryClient } from "../telemetry/index.js";
import { randomUUID } from "node:crypto";
import { CallLedger } from "../evaluation/CallLedger.js";

export type RouterRuntimeDeps = {
  modelRuntime: ModelRuntime;
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
  const cachePlanRebuildEnabled = resolveCachePlanRebuildEnabled(config.cachePlanRebuild?.enabled);
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
  const usageCache = new SessionUsageCache();
  const customRouters = deps.customRouterRegistry ?? noopCustomRouterRegistry;
  const judgeRuntime = deps.judgeRuntime ?? deps.modelRuntime;
  const events = deps.events ?? { emit: () => undefined };
  const telemetry = deps.telemetry;
  const ledger = config.stats?.ledgerFilePath
    ? new CallLedger({ filePath: config.stats.ledgerFilePath, modelPricing: config.stats.modelPricing })
    : undefined;
  const ledgerDefaults = {
    runId: config.stats?.runId ?? "unconfigured-run",
    taskId: config.stats?.taskId ?? "unconfigured-task",
    strategyVersion: config.stats?.strategyVersion ?? "unknown",
    baselineCommit: config.stats?.baselineCommit ?? "unknown",
  };
  const healthTrackers = new Map<string, ProviderHealthTracker>();
  const endpointHealth = new ProviderHealthTracker({
    ...config.recovery?.health,
    now: () => (deps.now?.() ?? new Date()).getTime(),
  });
  function getHealthTracker(sessionId: string): ProviderHealthTracker {
    let tracker = healthTrackers.get(sessionId);
    if (!tracker) {
      tracker = new ProviderHealthTracker();
      healthTrackers.set(sessionId, tracker);
    }
    return tracker;
  }

  function missingForModel(
    ref: RouterModelRef,
    required: readonly InputModality[],
  ): InputModality[] {
    if (required.length === 0) {
      return [];
    }
    try {
      return missingInputModalities(
        deps.modelRuntime.getMultimodal(ref.provider, ref.model),
        required,
      );
    } catch {
      return [...required];
    }
  }

  function supportsMediaRequirements(
    ref: RouterModelRef,
    required: readonly InputModality[],
  ): boolean {
    return missingForModel(ref, required).length === 0;
  }

  function supportsRequestCapabilities(ref: RouterModelRef, request: CanonicalModelRequest): boolean {
    try {
      const capabilities = deps.modelRuntime.getCapabilities(ref.provider, ref.model);
      if (request.tools?.length && !capabilities.supportsToolUse) return false;
      if (request.stream && !capabilities.supportsStreaming) return false;
      if (request.systemPrompt && !capabilities.supportsSystemPrompt) return false;
      if (request.thinking?.enabled && request.thinking.mode !== "off" && !capabilities.supportsThinking) return false;
      if (request.outputSchema && !capabilities.supportsJsonSchema) return false;
      const estimatedInput = countMessagesTokens(request.messages);
      const requestedOutput = request.maxOutputTokens ?? 0;
      return estimatedInput + requestedOutput <= capabilities.maxContextTokens;
    } catch {
      return false;
    }
  }

  function fallbackCandidatesFor(scenarioType: RouterScenarioType): RouterModelRef[] {
    const candidates: RouterModelRef[] = [];
    const add = (refs: RouterModelRef[] | undefined) => {
      for (const ref of refs ?? []) {
        const id = ref.id || `${ref.provider}/${ref.model}`;
        if (!candidates.some((candidate) => candidate.provider === ref.provider && candidate.model === ref.model)) {
          candidates.push({ ...ref, id });
        }
      }
    };
    add((config.fallback as Record<string, RouterModelRef[] | undefined> | undefined)?.[scenarioType]);
    add(config.fallback?.default);
    return candidates;
  }

  function findCompatibleFallback(
    scenarioType: RouterScenarioType,
    required: readonly InputModality[],
  ): RouterModelRef | undefined {
    return fallbackCandidatesFor(scenarioType)
      .find((ref) => supportsMediaRequirements(ref, required));
  }

  function rerouteDecisionForMedia(
    decision: RouterDecision,
    messages: CanonicalModelRequest["messages"],
    mutations: RouterMutationsLog,
  ): RouterMutationsLog {
    const required = collectRequiredInputModalities(messages);
    if (required.length === 0) {
      return mutations;
    }

    const selected: RouterModelRef = {
      id: `${decision.provider}/${decision.model}`,
      provider: decision.provider,
      model: decision.model,
    };
    if (supportsMediaRequirements(selected, required)) {
      return mutations;
    }

    const replacement = findCompatibleFallback(decision.scenarioType, required);
    if (!replacement) {
      return mutations;
    }

    decision.provider = replacement.provider;
    decision.model = replacement.model;
    decision.resolvedFrom = "fallback";
    return {
      ...mutations,
      mediaCapabilityRerouted: {
        required: [...required],
        from: selected.id,
        to: replacement.id || `${replacement.provider}/${replacement.model}`,
      },
    };
  }

  /**
   * Cache-aware stay/switch arbitration between the previous sticky model
   * (`current`) and the token-saver judge's fresh tier selection (`next`).
   *
   * All stay/switch cost math is delegated to the four-bucket estimator
   * (`compareStayVsSwitch`): both sides are priced as mutually-exclusive
   * input / cacheRead / cacheWrite buckets plus output. Two contract rules
   * are encoded there — the SUNK-COST rule (a stay never re-charges the
   * cache write; it was paid on an earlier turn) and the cold-start rule (a
   * switch to a cache-capable target pays a full-input cache write, a
   * non-caching target pays plain input).
   *
   * v1 intervention boundary: the estimator may only override the judge when
   * the stay side has POSITIVE cache evidence (cacheReadTokens or
   * cacheWriteTokens > 0 in the keyed or session-level usage cache) and the
   * recommendation is not `"unknown"`; otherwise the judge's tier choice
   * stands and no mutation is logged.
   */
  function maybePreserveStickyForCache(
    current: RouterModelRef | undefined,
    next: RouterModelRef,
    request: CanonicalModelRequest,
    sessionId: string,
  ): { selection: RouterModelRef; mutation?: RouterMutationsLog["cacheAwareSwitch"] } {
    const cacheAware = config.tokenSaver?.cacheAwareSwitching;
    if (cacheAware?.enabled === false || !current) {
      return { selection: next };
    }
    if (current.provider === next.provider && current.model === next.model) {
      return { selection: next };
    }

    const stayEntry = usageCache.getEntry(sessionId, current.provider, current.model)
      ?? usageCache.getEntry(sessionId);
    const stayUsage = stayEntry?.usage;
    const stayHasCacheEvidence = (stayUsage?.cacheReadTokens ?? 0) > 0
      || (stayUsage?.cacheWriteTokens ?? 0) > 0;
    if (!stayEntry || !stayUsage || !stayHasCacheEvidence) {
      return { selection: next };
    }

    const estimatedInputTokens = estimateRequestInputTokens(request);
    const estimatedOutputTokens = stayUsage.outputTokens ?? 0;
    const now = (deps.now?.() ?? new Date()).getTime();
    const modelPricing = config.stats?.modelPricing;
    const switchEntry = usageCache.getEntry(sessionId, next.provider, next.model);

    const comparison = compareStayVsSwitch({
      stay: {
        provider: current.provider,
        model: current.model,
        supportsPromptCache: supportsPromptCacheFor(deps.modelRuntime, current.provider, current.model),
        estimatedInputTokens,
        estimatedOutputTokens,
        cacheEvidence: {
          provider: current.provider,
          model: current.model,
          inputTokens: stayUsage.inputTokens,
          cacheReadTokens: stayUsage.cacheReadTokens,
          cacheWriteTokens: stayUsage.cacheWriteTokens,
          outputTokens: stayUsage.outputTokens,
          observedAt: stayEntry.observedAt,
        },
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
        now,
        modelPricing,
        role: "stay",
      },
      switch: {
        provider: next.provider,
        model: next.model,
        supportsPromptCache: supportsPromptCacheFor(deps.modelRuntime, next.provider, next.model),
        estimatedInputTokens,
        estimatedOutputTokens,
        ...(switchEntry
          ? {
            cacheEvidence: {
              provider: next.provider,
              model: next.model,
              inputTokens: switchEntry.usage.inputTokens,
              cacheReadTokens: switchEntry.usage.cacheReadTokens,
              cacheWriteTokens: switchEntry.usage.cacheWriteTokens,
              outputTokens: switchEntry.usage.outputTokens,
              observedAt: switchEntry.observedAt,
            },
          }
          : {}),
        cacheTtlMs: DEFAULT_CACHE_TTL_MS,
        now,
        modelPricing,
        role: "switch",
      },
      minSavingsRatio: cacheAware?.minSavingsRatio ?? 0,
    });

    if (comparison.recommendation === "unknown") {
      return { selection: next };
    }

    const { stay, switch: target } = comparison;
    return {
      selection: comparison.recommendation === "switch" ? next : current,
      mutation: {
        action: comparison.recommendation === "switch" ? "switched" : "kept_sticky",
        from: `${current.provider}/${current.model}`,
        to: `${next.provider}/${next.model}`,
        cachedCost: stay.costs.input + stay.costs.cacheRead + stay.costs.cacheWrite,
        prefillCost: target.costs.input + target.costs.cacheWrite,
        estimatedInputTokens,
        stayTotalCost: stay.costs.total,
        switchTotalCost: target.costs.total,
        savings: comparison.savings,
        uncertainty: worseUncertainty(stay.uncertainty, target.uncertainty),
        pricingSource: `${stay.pricing.source}/${target.pricing.source}`,
        stayBuckets: stay.buckets,
        switchBuckets: target.buckets,
        usageEvidence: stripUndefined({
          provider: current.provider,
          model: current.model,
          inputTokens: stayUsage.inputTokens,
          cacheReadTokens: stayUsage.cacheReadTokens,
          cacheWriteTokens: stayUsage.cacheWriteTokens,
          observedAt: stayEntry.observedAt,
        }),
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

    const sticky = sessionStore.get(input.sessionId, !input.isMainAgent);
    const previousStickySelection = (input.metadata?.previousProvider && input.metadata.previousModel)
      ? {
        id: `${input.metadata.previousProvider}/${input.metadata.previousModel}`,
        provider: input.metadata.previousProvider,
        model: input.metadata.previousModel,
      }
      : sticky?.stickyProvider && sticky.stickyModel
      ? { id: `${sticky.stickyProvider}/${sticky.stickyModel}`, provider: sticky.stickyProvider, model: sticky.stickyModel }
      : undefined;
    // Prefer the usage observed for the model we were actually sticky on; the
    // session-level slot is the legacy fallback (seeded via observeUsage).
    const baseUsage = usageCache.get(
      input.sessionId,
      previousStickySelection?.provider,
      previousStickySelection?.model,
    ) ?? usageCache.get(input.sessionId);
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

    const custom = await resolveCustom(inputWithUsage);
    const scenarioOutcome = decideScenario(inputWithUsage, config.scenarios ?? {} as any);

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
    let tokenSaverRouting: TokenSaverRoutingDiagnostics | undefined;
    let cacheAwareSwitch: RouterMutationsLog["cacheAwareSwitch"];
    const subagentPolicy = config.tokenSaver?.subagent?.policy ?? DEFAULT_SUBAGENT_POLICY;
    if (
      !custom?.provider &&
      scenarioType !== "explicit" &&
      config.tokenSaver?.enabled &&
      (input.isMainAgent || subagentPolicy !== "skip")
    ) {
      let stickyHit = false;

      if (input.isMainAgent && input.request.messages.length > 1) {
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

      if (!input.isMainAgent && subagentPolicy === "judge" && input.request.messages.length > 1) {
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
        const judgeCallId = randomUUID();
        let judgeAttemptSequence = 0;
        const tokenSaver = await classifyAndRoute({
          config: config.tokenSaver,
          messages: input.request.messages,
          judgeRuntime,
          abortSignal: input.abortSignal,
          previousTier: input.metadata?.previousTier,
          availableToolCount: input.request.tools?.length ?? 0,
          sessionId: input.sessionId,
          telemetry,
          onJudgeAttempt: ledger ? (judgeAttempt) => {
            judgeAttemptSequence += 1;
            ledger.append({
              ...ledgerDefaults,
              sessionId: input.sessionId,
              callId: judgeCallId,
              provider: config.tokenSaver!.judge.provider,
              model: config.tokenSaver!.judge.model,
              role: "judge",
              attemptNumber: judgeAttemptSequence,
              startedAt: judgeAttempt.startedAt,
              endedAt: judgeAttempt.endedAt,
              status: judgeAttempt.status,
              errorType: judgeAttempt.errorType,
              usage: judgeAttempt.usage,
              usageSource: judgeAttempt.usage ? "provider_reported" : "unknown",
            });
          } : undefined,
        });
        if (tokenSaver) {
          tokenSaverRouting = tokenSaver.diagnostics;
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
            const cacheAware = maybePreserveStickyForCache(
              previousStickySelection,
              selection,
              input.request,
              input.sessionId,
            );
            selection = cacheAware.selection;
            cacheAwareSwitch = cacheAware.mutation;
          }
          tokenSaverTier = cacheAwareSwitch?.action === "kept_sticky"
            ? (sticky?.tokenSaverTier ?? input.metadata?.previousTier ?? tokenSaver.tier)
            : tokenSaver.tier;
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
    if (tokenSaverRouting) {
      mutations = { ...mutations, tokenSaverRouting };
    }
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

    const mediaMessages = decision.requestPatch?.messages ?? input.request.messages;
    mutations = rerouteDecisionForMedia(decision, mediaMessages, mutations);

    decision.mutations = mutations;

    sessionStore.set({
      sessionId: input.sessionId,
      isSubagent: !input.isMainAgent,
      tokenSaverTier,
      stickyProvider: decision.provider,
      stickyModel: decision.model,
      orchestrating: decision.orchestrating,
      lastUsage: sticky?.lastUsage,
      updatedAt: (deps.now?.() ?? new Date()).getTime(),
    });

    events.emit({
      type: "pilotdeck_router_decision",
      sessionId: input.sessionId,
      decision,
    });

    return decision;
  }

  /**
   * Resolve cachePlan/cacheBreakpoints for the request as routed.
   *
   * With the rebuild flag ON: a plan-carrying request gets its plan rebuilt
   * for the final model (explicit clear when the final model fails the
   * protocol + prompt-cache gate); legacy breakpoints-only requests keep
   * their breakpoints only when the final model passes the same gate.
   * With the flag OFF the pre-rebuild drop behavior is preserved
   * byte-for-byte (experiment control arm).
   */
  function resolveRoutedCache(
    previous: CanonicalModelRequest,
    routed: Pick<CanonicalModelRequest, "provider" | "model" | "systemPrompt" | "tools" | "messages">,
  ): { cachePlan?: CachePlan; cacheBreakpoints?: number[] } {
    if (!cachePlanRebuildEnabled) {
      const keptPlan = previous.cachePlan &&
        (previous.cachePlan.provider === undefined || previous.cachePlan.provider === routed.provider) &&
        (previous.cachePlan.model === undefined || previous.cachePlan.model === routed.model)
        ? previous.cachePlan
        : undefined;
      return {
        cachePlan: keptPlan,
        cacheBreakpoints: previous.cachePlan !== undefined
          ? keptPlan?.messages
          : previous.cacheBreakpoints,
      };
    }
    if (previous.cachePlan !== undefined) {
      return rebuildRoutedCachePlan({
        provider: routed.provider,
        model: routed.model,
        protocol: protocolForProvider(deps.modelRuntime, routed.provider),
        supportsPromptCache: supportsPromptCacheFor(deps.modelRuntime, routed.provider, routed.model),
        systemPrompt: routed.systemPrompt,
        tools: routed.tools ?? [],
        messages: routed.messages,
      }, previous.cachePlan);
    }
    if (previous.cacheBreakpoints !== undefined) {
      const cacheCapable =
        protocolForProvider(deps.modelRuntime, routed.provider) === "anthropic" &&
        supportsPromptCacheFor(deps.modelRuntime, routed.provider, routed.model);
      return cacheCapable
        ? { cacheBreakpoints: previous.cacheBreakpoints }
        : { cacheBreakpoints: undefined };
    }
    // No plan and no breakpoints: the prepare-time gate ran for a model that
    // could not use the prompt cache. Re-evaluate for the finally-routed
    // model — build a fresh plan (generation 0) when it passes the gate,
    // keep the explicit clear when it does not.
    return rebuildRoutedCachePlan({
      provider: routed.provider,
      model: routed.model,
      protocol: protocolForProvider(deps.modelRuntime, routed.provider),
      supportsPromptCache: supportsPromptCacheFor(deps.modelRuntime, routed.provider, routed.model),
      systemPrompt: routed.systemPrompt,
      tools: routed.tools ?? [],
      messages: routed.messages,
    }, undefined);
  }

  function applyDecisionToRequest(
    decision: RouterDecision,
    request: CanonicalModelRequest,
  ): CanonicalModelRequest {
    let messages = decision.requestPatch?.messages ?? request.messages;
    if (decision.mutations.subagentTagStripped) {
      messages = stripSubagentTagFromMessages(messages);
    }
    const composed: CanonicalModelRequest = {
      ...request,
      ...decision.requestPatch,
      provider: decision.provider,
      model: decision.model,
      messages,
    };
    const routedCache = resolveRoutedCache(request, composed);
    return clampMaxOutputTokensToModelCap({
      ...composed,
      cachePlan: routedCache.cachePlan,
      cacheBreakpoints: routedCache.cacheBreakpoints,
    }, deps.modelRuntime);
  }

  async function* execute(
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext,
  ): AsyncIterable<CanonicalModelEvent> {
    if (!enabled) {
      const callId = randomUUID();
      const logicalStartedAt = (deps.now?.() ?? new Date()).toISOString();
      let providerAttemptCount = 0;
      let previousAttemptId: string | undefined;
      const recordProviderAttempt = (providerAttempt: ProviderAttemptEvent) => {
        const attemptId = randomUUID();
        providerAttemptCount += 1;
        ledger?.append({
          ...ledgerDefaults,
          sessionId: ctx.sessionId,
          taskId: config.stats?.taskId ?? ctx.turnId,
          decisionId: ctx.turnId,
          callId,
          attemptId,
          parentId: decision.isSubagent ? ctx.sessionId : undefined,
          provider: providerAttempt.provider,
          model: providerAttempt.model,
          role: ctx.callRole ?? (providerAttemptCount > 1 ? "retry" : decision.isSubagent ? "subagent" : "main"),
          attemptNumber: providerAttemptCount,
          startedAt: providerAttempt.startedAt,
          endedAt: providerAttempt.endedAt,
          status: providerAttempt.status,
          errorType: providerAttempt.errorType,
          usage: providerAttempt.usage,
          usageSource: providerAttempt.usage ? "provider_reported" : "unknown",
          retryOfAttemptId: providerAttemptCount > 1 ? previousAttemptId : undefined,
        });
        previousAttemptId = attemptId;
      };
      const passthroughBase: CanonicalModelRequest = {
        ...request,
        provider: decision.provider,
        model: decision.model,
      };
      const routedCache = resolveRoutedCache(request, passthroughBase);
      const passthroughRequest: CanonicalModelRequest = {
        ...passthroughBase,
        cachePlan: routedCache.cachePlan,
        cacheBreakpoints: routedCache.cacheBreakpoints,
      };
      const downgradedPassthrough = downgradeRequestForAttempt(
        passthroughRequest,
        { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model },
        deps.modelRuntime,
      );
      const cappedPassthroughRequest = clampMaxOutputTokensToModelCap(downgradedPassthrough, deps.modelRuntime);
      let sawErrorEvent = false;
      let passthroughOutcome: AttemptOutcome | undefined;
      for await (const item of streamAttempt(
        cappedPassthroughRequest,
        deps.modelRuntime,
        ctx,
        events,
        { onProviderAttempt: recordProviderAttempt },
      )) {
        if (item.kind === "event") {
          if (item.event.type === "error") {
            sawErrorEvent = true;
          }
          yield item.event;
          continue;
        }
        passthroughOutcome = item.outcome;
        if (item.outcome.error && !sawErrorEvent) {
          yield { type: "error", error: item.outcome.error };
        }
      }
      if (providerAttemptCount === 0) {
        recordProviderAttempt({
          provider: decision.provider,
          model: decision.model,
          attempt: 1,
          startedAt: logicalStartedAt,
          endedAt: (deps.now?.() ?? new Date()).toISOString(),
          status: passthroughOutcome?.error ? "failed" : "succeeded",
          usage: passthroughOutcome?.usage,
          errorType: passthroughOutcome?.error?.code,
        });
      }
      return;
    }

    const startedAt = (deps.now?.() ?? new Date()).toISOString();
    const fallbackPlan = planFallback(config.fallback, decision.scenarioType);
    const baseRequest = applyDecisionToRequest(decision, request);
    const requiredModalities = collectRequiredInputModalities(baseRequest.messages);
    const requestedAttempt: RouterModelRef = {
      id: `${decision.provider}/${decision.model}`,
      provider: decision.provider,
      model: decision.model,
    };
    const recoveryEnabled = config.recovery?.enabled === true;
    const recoveryStartedMs = (deps.now?.() ?? new Date()).getTime();
    const recoveryDeadlineAt = recoveryStartedMs + (config.recovery?.deadlineMs ?? 30_000);
    const recoveryMaxAttempts = config.recovery?.maxAttempts ?? 6;
    let recoveryAttemptCount = 0;
    const blockedCredentialProviders = new Set<string>();
    const blockedFallbackDomains = new Set<string>();
    const candidateAttempts: RouterModelRef[] = [
      requestedAttempt,
      ...fallbackPlan.attempts,
    ].filter((attempt, index, all) =>
      all.findIndex((candidate) =>
        candidate.provider === attempt.provider && candidate.model === attempt.model
      ) === index
    ).filter((attempt, index) => index === 0 || !recoveryEnabled || supportsRequestCapabilities(attempt, baseRequest));
    const nativeAttempts: RouterModelRef[] = candidateAttempts
      .filter((attempt) => supportsMediaRequirements(attempt, requiredModalities));
    const downgradedAttempts: RouterModelRef[] = requiredModalities.length > 0
      ? candidateAttempts.filter((attempt) => !supportsMediaRequirements(attempt, requiredModalities))
      : [];
    const attemptPlans: AttemptPlan[] = [
      ...nativeAttempts.map((attempt) => ({ attempt, downgradeUnsupportedMedia: false })),
      ...downgradedAttempts.map((attempt) => ({ attempt, downgradeUnsupportedMedia: true })),
    ];
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
    let lastErrorYielded = false;
    const callId = randomUUID();
    let attemptSequence = 0;
    let previousAttemptId: string | undefined;

    if (attemptPlans.length === 0) {
      const missing = missingForModel(requestedAttempt, requiredModalities);
      const error = createUnsupportedMediaError(
        requestedAttempt,
        requiredModalities,
        missing,
        protocolForProvider(deps.modelRuntime, requestedAttempt.provider),
      );
      events.emit({
        type: "pilotdeck_router_execute_failed",
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        scenarioType: decision.scenarioType,
        provider: requestedAttempt.provider,
        model: requestedAttempt.model,
        error,
      });
      yield { type: "error", error };
      return;
    }

    let activeHealthDomain: string | undefined;
    try {
      outer: for (let attemptIndex = 0; attemptIndex < attemptPlans.length; attemptIndex += 1) {
      if (ctx.abortSignal?.aborted) {
        throwAbortError(ctx.abortSignal.reason);
      }
      const attemptPlan = attemptPlans[attemptIndex];
      const attempt = attemptPlan.attempt;
      const healthDomain = providerFailureDomain(deps.modelRuntime, attempt);
      if (recoveryEnabled) {
        if (
          (attemptIndex > 0 && blockedCredentialProviders.has(attempt.provider)) ||
          (attemptIndex > 0 && blockedFallbackDomains.has(healthDomain))
        ) continue;
        if (!endpointHealth.tryAcquire(healthDomain)) {
          lastAttempt = attempt;
          lastDecision = {
            ...decision,
            provider: attempt.provider,
            model: attempt.model,
            resolvedFrom: attemptIndex === 0 ? decision.resolvedFrom : "fallback",
          };
          lastError = {
            provider: attempt.provider,
            model: attempt.model,
            protocol: protocolForProvider(deps.modelRuntime, attempt.provider),
            code: "provider_circuit_open",
            message: "HALO deferred this provider because its recovery probe is unavailable.",
            retryable: true,
          };
          continue;
        }
        activeHealthDomain = healthDomain;
      } else if (attemptIndex > 0) {
        if (
          getHealthTracker(ctx.sessionId).shouldSkip(attempt.provider) &&
          attemptIndex < attemptPlans.length - 1
        ) continue;
      }
      const attemptDecision: RouterDecision = {
        ...decision,
        provider: attempt.provider,
        model: attempt.model,
        resolvedFrom: attemptIndex === 0 ? decision.resolvedFrom : "fallback",
      };
      let attemptRequest = applyDecisionToRequest(attemptDecision, request);
      if (attemptPlan.downgradeUnsupportedMedia) {
        attemptRequest = downgradeRequestForAttempt(attemptRequest, attempt, deps.modelRuntime);
      }
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
      let planHasLedgerAttempt = false;
      while (true) {
        const dispatchStartedMs = (deps.now?.() ?? new Date()).getTime();
        const remainingMs = recoveryDeadlineAt - dispatchStartedMs;
        if (recoveryEnabled && (recoveryAttemptCount >= recoveryMaxAttempts || remainingMs <= 0)) {
          endpointHealth.release(healthDomain);
          if (!lastError) {
            lastError = {
              provider: attempt.provider,
              model: attempt.model,
              protocol: protocolForProvider(deps.modelRuntime, attempt.provider),
              code: "recovery_budget_exhausted",
              message: `HALO recovery budget exhausted after ${recoveryAttemptCount} dispatches.`,
              retryable: false,
            };
            lastAttempt = attempt;
          }
          break outer;
        }
        recoveryAttemptCount++;
        const dispatchAttempt = recoveryAttemptCount;
        zeroUsageAttempt += 1;
        const attemptStartedAt = (deps.now?.() ?? new Date()).toISOString();
        // Live-stream events. We track whether we've already surfaced any
        // content event (text/thinking/tool) to the consumer; once we have,
        // fallback / retry is no longer safe (would duplicate text).
        let hasYieldedContent = false;
        const pending: CanonicalModelEvent[] = [];
        let outcome: AttemptOutcome | undefined;
        let providerAttemptObserved = false;
        const recordProviderAttempt = (providerAttempt: ProviderAttemptEvent) => {
          const firstInPlan = !planHasLedgerAttempt;
          const currentAttemptId = randomUUID();
          providerAttemptObserved = true;
          planHasLedgerAttempt = true;
          attemptSequence += 1;
          ledger?.append({
            ...ledgerDefaults,
            sessionId: ctx.sessionId,
            taskId: config.stats?.taskId ?? ctx.turnId,
            decisionId: ctx.turnId,
            callId,
            attemptId: currentAttemptId,
            parentId: decision.isSubagent ? ctx.sessionId : undefined,
            provider: providerAttempt.provider,
            model: providerAttempt.model,
            role: ctx.callRole ?? (firstInPlan
              ? attemptIndex > 0 ? "fallback" : decision.isSubagent ? "subagent" : "main"
              : "retry"),
            attemptNumber: attemptSequence,
            startedAt: providerAttempt.startedAt,
            endedAt: providerAttempt.endedAt,
            status: providerAttempt.status,
            errorType: providerAttempt.errorType,
            usage: providerAttempt.usage,
            usageSource: providerAttempt.usage ? "provider_reported" : "unknown",
            retryOfAttemptId: firstInPlan ? undefined : previousAttemptId,
            fallbackFromAttemptId: firstInPlan && attemptIndex > 0 ? previousAttemptId : undefined,
          });
          previousAttemptId = currentAttemptId;
        };
        let currentDispatchAttempt = dispatchAttempt;
        let currentDispatchStartedMs = dispatchStartedMs;
        let currentDispatchEnded = false;
        let pendingContinuationAttempt: number | undefined;
        let observedProviderDispatches = 0;

        events.emit({
          type: "pilotdeck_router_attempt",
          phase: "start",
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          attempt: dispatchAttempt,
          provider: attempt.provider,
          model: attempt.model,
          failureDomain: healthDomain,
        });
        for await (const item of streamAttempt(attemptRequest, deps.modelRuntime, ctx, events, {
          timeoutMs: recoveryEnabled ? remainingMs : undefined,
          allowRetry: recoveryEnabled
            ? (retry) => {
                if (retry.reason !== "continuation") return false;
                const retryRemainingMs = recoveryDeadlineAt - (deps.now?.() ?? new Date()).getTime();
                if (
                  recoveryAttemptCount >= recoveryMaxAttempts ||
                  retry.delayMs >= retryRemainingMs
                ) return false;
                recoveryAttemptCount++;
                pendingContinuationAttempt = recoveryAttemptCount;
                events.emit({
                  type: "pilotdeck_router_attempt",
                  phase: "end",
                  sessionId: ctx.sessionId,
                  turnId: ctx.turnId,
                  attempt: currentDispatchAttempt,
                  provider: attempt.provider,
                  model: attempt.model,
                  failureDomain: healthDomain,
                  latencyMs: Math.max(0, (deps.now?.() ?? new Date()).getTime() - currentDispatchStartedMs),
                  errorCode: "stream_interrupted",
                });
                currentDispatchEnded = true;
                return true;
              }
            : undefined,
          onProviderDispatchStart: recoveryEnabled
            ? () => {
                observedProviderDispatches++;
                if (observedProviderDispatches === 1 || pendingContinuationAttempt == null) return;
                currentDispatchAttempt = pendingContinuationAttempt;
                pendingContinuationAttempt = undefined;
                currentDispatchStartedMs = (deps.now?.() ?? new Date()).getTime();
                currentDispatchEnded = false;
                events.emit({
                  type: "pilotdeck_router_attempt",
                  phase: "start",
                  sessionId: ctx.sessionId,
                  turnId: ctx.turnId,
                  attempt: currentDispatchAttempt,
                  provider: attempt.provider,
                  model: attempt.model,
                  failureDomain: healthDomain,
                });
              }
            : undefined,
          onProviderAttempt: recordProviderAttempt,
        })) {
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

        if (!outcome) {
          lastHasYieldedContent = hasYieldedContent;
          break outer;
        }

        lastBuffered = outcome.buffered;
        lastUsage = outcome.usage;
        if (!providerAttemptObserved) {
          recordProviderAttempt({
            provider: attempt.provider,
            model: attempt.model,
            attempt: 1,
            startedAt: attemptStartedAt,
            endedAt: (deps.now?.() ?? new Date()).toISOString(),
            status: outcome.error ? "failed" : "succeeded",
            usage: outcome.usage,
            errorType: outcome.error?.code,
          });
        }
        const dispatchEndedMs = (deps.now?.() ?? new Date()).getTime();
        const dispatchLatencyMs = Math.max(0, dispatchEndedMs - currentDispatchStartedMs);
        if (!currentDispatchEnded) {
          events.emit({
            type: "pilotdeck_router_attempt",
            phase: "end",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            attempt: currentDispatchAttempt,
            provider: attempt.provider,
            model: attempt.model,
            failureDomain: healthDomain,
            latencyMs: dispatchLatencyMs,
            errorCode: outcome.error?.code,
            usage: outcome.usage,
            finishReason: lastFinishReason(outcome.buffered),
          });
        }

        if (outcome.error) {
          lastError = outcome.error;
          const recoverySignal = classifyRecoverySignal(outcome.error);
          if (recoveryEnabled) {
            if (recoverySignal === "service") endpointHealth.recordFailure(healthDomain, outcome.error.retryAfterMs, dispatchLatencyMs);
            else endpointHealth.release(healthDomain);
            if (recoverySignal === "credential") blockedCredentialProviders.add(attempt.provider);
            if (outcome.error.code === "rate_limit_error") blockedFallbackDomains.add(healthDomain);
            rankRemainingAttempts(
              attemptPlans,
              attemptIndex + 1,
              endpointHealth,
              deps.modelRuntime,
              healthDomain,
              countMessagesTokens(attemptRequest.messages),
              config.stats?.modelPricing,
            );
          } else {
            getHealthTracker(ctx.sessionId).recordFailure(attempt.provider);
          }
          const preferFallback = !recoveryEnabled || !transientRetryEnabled || recoverySignal !== "service" || outcome.error.code === "rate_limit_error" || transientRetryCount > 0;
          if (!hasYieldedContent && isFallbackEligible(outcome.error) && preferFallback) {
            const nextIndex = recoveryEnabled
              ? attemptPlans.findIndex((plan, index) => {
                  if (index <= attemptIndex || blockedCredentialProviders.has(plan.attempt.provider)) return false;
                  const domain = providerFailureDomain(deps.modelRuntime, plan.attempt);
                  return !blockedFallbackDomains.has(domain) && !endpointHealth.shouldSkip(domain);
                })
              : attemptIndex + 1 < attemptPlans.length ? attemptIndex + 1 : -1;
            if (nextIndex >= 0) {
              if (nextIndex !== attemptIndex + 1) {
                [attemptPlans[attemptIndex + 1], attemptPlans[nextIndex]] = [attemptPlans[nextIndex], attemptPlans[attemptIndex + 1]];
              }
              const next = attemptPlans[attemptIndex + 1].attempt;
              events.emit({
                type: "pilotdeck_router_fallback",
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                scenarioType: attemptDecision.scenarioType,
                attempt: attemptIndex + 1,
                fromProvider: attempt.provider,
                fromModel: attempt.model,
                toProvider: next.provider,
                toModel: next.model,
                error: outcome.error,
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
                  attempt: attemptIndex + 1,
                  fromProvider: attempt.provider,
                  fromModel: attempt.model,
                  toProvider: next.provider,
                  toModel: next.model,
                  errorCode: outcome.error.code,
                },
              });
              continue outer;
            }
          }
          if (
            !hasYieldedContent &&
            isFallbackEligible(outcome.error) &&
            transientRetryEnabled &&
            transientRetryCount < transientRetryMax &&
            (!recoveryEnabled || recoverySignal === "service" || outcome.error.code === "invalid_tool_arguments") &&
            (!recoveryEnabled || recoveryAttemptCount < recoveryMaxAttempts)
          ) {
            const delay = outcome.error.retryAfterMs != null
              ? recoveryEnabled ? outcome.error.retryAfterMs : Math.min(outcome.error.retryAfterMs, transientMaxDelayMs)
              : calculateLiteLLMRetryDelay(transientRetryCount, transientBaseDelayMs, transientMaxDelayMs);
            const retryRemainingMs = recoveryDeadlineAt - (deps.now?.() ?? new Date()).getTime();
            if (recoveryEnabled && (delay >= retryRemainingMs || delay < 0)) {
              continue outer;
            }
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
            if (queued.type !== "error") yield queued;
          }
          lastHasYieldedContent = hasYieldedContent;
          lastErrorYielded = hasYieldedContent;
          break outer;
        }

        if (
          !hasYieldedContent &&
          zeroUsageEnabled &&
          outcome.shouldRetryZeroUsage &&
          zeroUsageAttempt < zeroUsageMax &&
          (!recoveryEnabled || recoveryAttemptCount < recoveryMaxAttempts)
        ) {
          const zeroUsageDelayMs = 500 * zeroUsageAttempt;
          const zeroUsageRemainingMs = recoveryDeadlineAt - (deps.now?.() ?? new Date()).getTime();
          if (recoveryEnabled && zeroUsageDelayMs >= zeroUsageRemainingMs) continue outer;
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
            delayMs: zeroUsageDelayMs,
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
          await abortableDelay(zeroUsageDelayMs, ctx.abortSignal);
          continue;
        }

        if (!hasYieldedContent && zeroUsageEnabled && outcome.shouldRetryZeroUsage) {
          endpointHealth.release(healthDomain);
          lastError = {
            provider: attempt.provider,
            model: attempt.model,
            protocol: protocolForProvider(deps.modelRuntime, attempt.provider),
            code: "empty_response",
            message: "Provider returned no content, tool call, finish reason, or usage after the retry budget.",
            retryable: false,
          };
          lastAttempt = attempt;
          break outer;
        }

        if (recoveryEnabled) endpointHealth.recordSuccess(healthDomain, dispatchLatencyMs);
        else getHealthTracker(ctx.sessionId).recordSuccess(attempt.provider);

        if (!hasYieldedContent) {
          for (const queued of pending) {
            yield queued;
          }
        }

        const endedAtDate = deps.now?.() ?? new Date();
        const endedAt = endedAtDate.toISOString();
        let finalUsage = outcome.usage;
        if (!finalUsage || (!finalUsage.inputTokens && !finalUsage.outputTokens)) {
          const inputEst = countMessagesTokens(attemptRequest.messages);
          const outputEst = countResponseTokens(outcome.buffered);
          finalUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
        }
        usageCache.observe(ctx.sessionId, finalUsage, {
          provider: attempt.provider,
          model: attempt.model,
          observedAt: endedAtDate.getTime(),
        });
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
          tokenSaverRouting: attemptDecision.mutations.tokenSaverRouting,
          usage: finalUsage,
          startedAt,
          endedAt,
        });
        return;
      }
    }
    } finally {
      if (activeHealthDomain) endpointHealth.release(activeHealthDomain);
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
        tokenSaverRouting: lastDecision.mutations.tokenSaverRouting,
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
      if (!lastErrorYielded) {
        yield { type: "error", error: { ...lastError, provider: lastAttempt.provider, model: lastAttempt.model } };
      }
    }
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
      metadata: ctx.previousTier ? { previousTier: ctx.previousTier } : undefined,
    });
    yield* execute(decision, request, ctx);
  }

  function invalidateSticky(sessionId: string): InvalidateStickyResult {
    if (!enabled) {
      return { orchestrating: false };
    }

    const current = sessionStore.get(sessionId, false);
    const previousTier = current?.tokenSaverTier;
    const previousProvider = current?.stickyProvider;
    const previousModel = current?.stickyModel;
    const orchestrating = current?.orchestrating ?? false;
    if (orchestrating && previousTier) {
      // While orchestrating, preserve the tier sticky so continuation turns
      // don't get re-judged and accidentally downgraded.
      sessionStore.set({
        sessionId,
        isSubagent: false,
        orchestrating,
        tokenSaverTier: previousTier,
        stickyProvider: current?.stickyProvider,
        stickyModel: current?.stickyModel,
        updatedAt: (deps.now?.() ?? new Date()).getTime(),
      });
    } else {
      sessionStore.set({
        sessionId,
        isSubagent: false,
        orchestrating,
        updatedAt: (deps.now?.() ?? new Date()).getTime(),
      });
    }
    return { previousTier, previousProvider, previousModel, orchestrating };
  }

  return {
    decide,
    execute,
    stream,
    materializeRequest: applyDecisionToRequest,
    invalidateSticky,
    observeUsage(sessionId, usage) {
      if (!enabled) return;
      usageCache.observe(sessionId, usage);
    },
    stats,
    async shutdown() {
      await stats.flush();
      stats.dispose();
      ledger?.dispose();
      disposeTokenizer();
      if (!externalStore) sessionStore.clear();
      usageCache.clear();
      healthTrackers.clear();
      endpointHealth.resetAll();
    },
  };
}

type AttemptPlan = {
  attempt: RouterModelRef;
  downgradeUnsupportedMedia: boolean;
};

function rankRemainingAttempts(
  plans: AttemptPlan[],
  start: number,
  health: ProviderHealthTracker,
  runtime: ModelRuntime,
  failedDomain: string,
  estimatedInputTokens: number,
  pricing?: RouterModelPricingMap,
): void {
  const ranked = plans.slice(start).map((plan, order) => {
    const domain = providerFailureDomain(runtime, plan.attempt);
    const state = health.getState(domain);
    const statePenalty = state === "open" ? 1_000_000 : state === "half_open" ? 20 : state === "degraded" ? 10 : 0;
    const sharedDomainPenalty = domain === failedDomain ? 100 : 0;
    const reliabilityPenalty = (1 - health.getSuccessRate(domain)) * 4;
    const latencyPenalty = (health.getLatencyEwmaMs(domain) ?? 0) / 10_000;
    const costPenalty = calculateInputCost(
      estimatedInputTokens,
      plan.attempt.provider,
      plan.attempt.model,
      pricing,
    );
    return { plan, order, score: statePenalty + sharedDomainPenalty + reliabilityPenalty + latencyPenalty + costPenalty };
  });
  ranked.sort((a, b) => a.score - b.score || a.order - b.order);
  plans.splice(start, ranked.length, ...ranked.map(({ plan }) => plan));
}

function lastFinishReason(events: CanonicalModelEvent[]): import("../model/index.js").CanonicalFinishReason | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === "message_end") return event.finishReason;
  }
  return undefined;
}

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

function downgradeRequestForAttempt(
  request: CanonicalModelRequest,
  attempt: RouterModelRef,
  modelRuntime: ModelRuntime,
): CanonicalModelRequest {
  let multimodal: ReturnType<ModelRuntime["getMultimodal"]>;
  try {
    multimodal = modelRuntime.getMultimodal(attempt.provider, attempt.model);
  } catch {
    // Unknown provider/model should still be reported by validateModelRequest.
    return request;
  }
  const messages = cloneMessages(request.messages);
  downgradeUnsupportedContent(messages, multimodal);
  return { ...request, messages };
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
  options?: {
    maxRetries?: number;
    timeoutMs?: number;
    allowRetry?: ModelRuntimeOptions["allowRetry"];
    onProviderDispatchStart?: () => void;
    onProviderAttempt?: (attempt: ProviderAttemptEvent) => void;
  },
): AsyncGenerator<
  | { kind: "event"; event: CanonicalModelEvent }
  | { kind: "outcome"; outcome: AttemptOutcome }
> {
  const buffered: CanonicalModelEvent[] = [];
  const state = createZeroUsageState();
  let providerError: import("../model/index.js").CanonicalModelError | undefined;
  const timeoutSignal = options?.timeoutMs != null
    ? AbortSignal.timeout(Math.max(1, Math.ceil(options.timeoutMs)))
    : undefined;
  const abortSignal = timeoutSignal && ctx.abortSignal
    ? AbortSignal.any([ctx.abortSignal, timeoutSignal])
    : timeoutSignal ?? ctx.abortSignal;

  try {
    for await (const event of modelRuntime.stream(request, {
      signal: abortSignal,
      maxRetries: options?.maxRetries,
      allowRetry: options?.allowRetry,
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
      onProviderAttempt: options?.onProviderAttempt,
    })) {
      if (abortSignal?.aborted) {
        throwAbortError(abortSignal.reason);
      }
      observeEventForZeroUsage(state, event);
      if (event.type === "request_started") options?.onProviderDispatchStart?.();
      buffered.push(event);
      if (event.type === "error") {
        providerError = event.error;
      }
      yield { kind: "event", event };
    }
  } catch (error) {
    if (ctx.abortSignal?.aborted) {
      throw error;
    }
    const fromError = (error as { error?: import("../model/index.js").CanonicalModelError })?.error;
    const protocol = protocolForProvider(modelRuntime, request.provider);
    providerError = fromError ?? canonicalizeModelRequestError(error, request, protocol) ?? {
      provider: request.provider,
      protocol,
      code: classifyNetworkErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: isNetworkTransient(error),
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

function supportsPromptCacheFor(modelRuntime: ModelRuntime, providerId: string, modelId: string): boolean {
  try {
    return modelRuntime.getCapabilities(providerId, modelId).supportsPromptCache === true;
  } catch {
    return false;
  }
}

const UNCERTAINTY_SEVERITY = { low: 0, medium: 1, high: 2, unknown: 3 } as const;

type UncertaintyLevel = keyof typeof UNCERTAINTY_SEVERITY;

/** The more severe of two uncertainty labels (low < medium < high < unknown). */
function worseUncertainty(a: UncertaintyLevel, b: UncertaintyLevel): UncertaintyLevel {
  return UNCERTAINTY_SEVERITY[a] >= UNCERTAINTY_SEVERITY[b] ? a : b;
}

/** Drops undefined-valued keys so logged evidence carries observed values only. */
function stripUndefined<T extends object>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined),
  ) as T;
}

/**
 * PILOTDECK_CACHE_PLAN_REBUILD env override for experiment A/B control:
 * "0" forces the feature OFF, "1" forces it ON, unset defers to the config
 * value (default on). Read once per runtime creation, never per request.
 */
function resolveCachePlanRebuildEnabled(configEnabled: boolean | undefined): boolean {
  const override = process.env.PILOTDECK_CACHE_PLAN_REBUILD;
  if (override === "0") return false;
  if (override === "1") return true;
  return configEnabled !== false;
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

function classifyNetworkErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const msg = error.message.toLowerCase();
  if (msg.includes("timeout") || error.name === "TimeoutError") return "timeout";
  if (msg.includes("abort") || error.name === "AbortError") return "aborted";
  return "network_error";
}

function classifyRetryReason(errorCode: string): "rate_limit" | "server_error" | "network_error" | "zero_usage" | "overloaded" {
  if (errorCode === "rate_limit_error") return "rate_limit";
  if (errorCode === "overloaded_error") return "overloaded";
  if (errorCode === "server_error") return "server_error";
  if (errorCode === "network_error" || errorCode === "timeout") return "network_error";
  return "server_error";
}

function calculateLiteLLMRetryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const deterministicDelay = baseDelayMs * (attempt + 1);
  const jitterDelay = deterministicDelay * LITELLM_RETRY_JITTER * Math.random();
  return Math.min(deterministicDelay + jitterDelay, maxDelayMs);
}

function createUnsupportedMediaError(
  attempt: RouterModelRef,
  required: readonly InputModality[],
  missing: readonly InputModality[],
  protocol: ModelProtocol,
): import("../model/index.js").CanonicalModelError {
  const missingText = (missing.length > 0 ? missing : required).join(", ");
  const requiredText = required.join(", ");
  return {
    provider: attempt.provider,
    protocol,
    code: "unsupported_modality",
    message:
      `Router could not find a configured fallback model for ${attempt.provider}/${attempt.model} ` +
      `that supports required input modalities: ${requiredText}. Missing: ${missingText}.`,
    retryable: false,
  };
}
