import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
  ModelProtocol,
} from "../model/index.js";
import { cloneMessages, downgradeUnsupportedContent, ModelRequestError } from "../model/index.js";
import type { InputModality } from "../model/index.js";
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
import { ProviderHealthTracker } from "./health/ProviderHealthTracker.js";
import {
  createZeroUsageState,
  observeEventForZeroUsage,
  shouldRetryZeroUsage,
} from "./retry/zeroUsageRetry.js";
import { TokenStatsCollector } from "./stats/TokenStatsCollector.js";
import { classifyAndRoute } from "./tokenSaver/classifyAndRoute.js";
import { countMessagesTokens, countResponseTokens, dispose as disposeTokenizer } from "./utils/countTokens.js";
import {
  collectRequiredInputModalities,
  missingInputModalities,
} from "./utils/mediaRequirements.js";
import type { TelemetryClient } from "../telemetry/index.js";

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
  const stats = new TokenStatsCollector({
    ...config.stats,
    enabled: enabled && (config.stats?.enabled ?? false),
    baselineModel: config.scenarios?.default
      ? { provider: config.scenarios.default.provider, model: config.scenarios.default.model }
      : config.stats?.baselineModel,
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
  const healthTrackers = new Map<string, ProviderHealthTracker>();
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
    const baseUsage = usageCache.get(input.sessionId);
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
        const tokenSaver = await classifyAndRoute({
          config: config.tokenSaver,
          messages: input.request.messages,
          judgeRuntime,
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
            });
          }
          if (tokenSaver.selection) {
            selection = tokenSaver.selection;
            resolvedFrom = "tokenSaver";
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
        if (config.autoOrchestrate.mainAgentModel) {
          decision.provider = config.autoOrchestrate.mainAgentModel.provider;
          decision.model = config.autoOrchestrate.mainAgentModel.model;
        }
      }
    }

    if (!input.isMainAgent && config.autoOrchestrate?.subagentModel) {
      decision.provider = config.autoOrchestrate.subagentModel.provider;
      decision.model = config.autoOrchestrate.subagentModel.model;
      mutations = { ...mutations, subagentModelOverride: true };
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

  function applyDecisionToRequest(
    decision: RouterDecision,
    request: CanonicalModelRequest,
  ): CanonicalModelRequest {
    let messages = decision.requestPatch?.messages ?? request.messages;
    if (decision.mutations.subagentTagStripped) {
      messages = stripSubagentTagFromMessages(messages);
    }
    return clampMaxOutputTokensToModelCap({
      ...request,
      ...decision.requestPatch,
      provider: decision.provider,
      model: decision.model,
      messages,
    }, deps.modelRuntime);
  }

  async function* execute(
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext,
  ): AsyncIterable<CanonicalModelEvent> {
    if (!enabled) {
      const passthroughRequest: CanonicalModelRequest = {
        ...request,
        provider: decision.provider,
        model: decision.model,
      };
      const downgradedPassthrough = downgradeRequestForAttempt(
        passthroughRequest,
        { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model },
        deps.modelRuntime,
      );
      const cappedPassthroughRequest = clampMaxOutputTokensToModelCap(downgradedPassthrough, deps.modelRuntime);
      let sawErrorEvent = false;
      for await (const item of streamAttempt(cappedPassthroughRequest, deps.modelRuntime, ctx.abortSignal)) {
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
    const fallbackPlan = planFallback(config.fallback, decision.scenarioType);
    const baseRequest = applyDecisionToRequest(decision, request);
    const requiredModalities = collectRequiredInputModalities(baseRequest.messages);
    const requestedAttempt: RouterModelRef = {
      id: `${decision.provider}/${decision.model}`,
      provider: decision.provider,
      model: decision.model,
    };
    const candidateAttempts: RouterModelRef[] = [
      requestedAttempt,
      ...fallbackPlan.attempts,
    ].filter((attempt, index, all) =>
      all.findIndex((candidate) =>
        candidate.provider === attempt.provider && candidate.model === attempt.model
      ) === index
    );
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
    const transientRetryMax = Math.max(1, config.transientRetry?.maxAttempts ?? 5);
    const transientBaseDelayMs = config.transientRetry?.baseDelayMs ?? 1000;
    const transientMaxDelayMs = config.transientRetry?.maxDelayMs ?? 30000;

    let lastBuffered: CanonicalModelEvent[] = [];
    let lastError: import("../model/index.js").CanonicalModelError | undefined;
    let lastUsage: import("../model/index.js").CanonicalUsage | undefined;
    let lastAttempt: RouterModelRef | undefined;
    let lastDecision: RouterDecision = decision;
    let lastHasYieldedContent = false;

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

    outer: for (let attemptIndex = 0; attemptIndex < attemptPlans.length; attemptIndex += 1) {
      if (ctx.abortSignal?.aborted) {
        return;
      }
      const attemptPlan = attemptPlans[attemptIndex];
      const attempt = attemptPlan.attempt;
      if (
        attemptIndex > 0 &&
        getHealthTracker(ctx.sessionId).shouldSkip(attempt.provider) &&
        attemptIndex < attemptPlans.length - 1
      ) {
        continue;
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
            type: "text_delta",
            text: `[PilotDeck] Sub-agent budget exceeded (${estimated} est. tokens > ${budget} limit). Terminating.`,
          } as CanonicalModelEvent;
          yield { type: "message_end", finishReason: "stop" } as CanonicalModelEvent;
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

        for await (const item of streamAttempt(attemptRequest, deps.modelRuntime, ctx.abortSignal)) {
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

        if (outcome.error) {
          lastError = outcome.error;
          getHealthTracker(ctx.sessionId).recordFailure(attempt.provider);
          if (!hasYieldedContent && isFallbackEligible(outcome.error)) {
            if (attemptIndex < attemptPlans.length - 1) {
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
            transientRetryCount < transientRetryMax
          ) {
            const delay = outcome.error.retryAfterMs != null
              ? Math.min(outcome.error.retryAfterMs, transientMaxDelayMs)
              : Math.min(
                  transientBaseDelayMs * Math.pow(2, transientRetryCount) + Math.random() * 500,
                  transientMaxDelayMs,
                );
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
          if (
            hasYieldedContent &&
            isMidStreamRateLimitError(outcome.error) &&
            transientRetryCount < transientRetryMax
          ) {
            const partialText = extractPartialText(outcome.buffered);
            if (partialText.length > 100) {
              const midDelay = outcome.error.retryAfterMs != null
                ? Math.min(outcome.error.retryAfterMs, transientMaxDelayMs)
                : Math.min(
                    transientBaseDelayMs * Math.pow(2, transientRetryCount) + Math.random() * 500,
                    transientMaxDelayMs,
                  );
              console.warn(
                `[PilotDeck] midStreamRetry: ${outcome.error.code} after partial content ` +
                `(attempt ${transientRetryCount + 1}/${transientRetryMax}, delay=${Math.round(midDelay)}ms)`,
              );
              events.emit({
                type: "pilotdeck_router_retry_progress",
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                attempt: transientRetryCount + 1,
                maxAttempts: transientRetryMax,
                delayMs: Math.round(midDelay),
                reason: classifyRetryReason(outcome.error.code),
                provider: attempt.provider,
                model: attempt.model,
              });
              await abortableDelay(midDelay, ctx.abortSignal);
              attemptRequest = buildMidStreamContinuationRequest(attemptRequest, partialText);
              transientRetryCount++;
              continue;
            }
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

        if (!hasYieldedContent) {
          for (const queued of pending) {
            yield queued;
          }
        }

        const endedAt = (deps.now?.() ?? new Date()).toISOString();
        let finalUsage = outcome.usage;
        if (!finalUsage || (!finalUsage.inputTokens && !finalUsage.outputTokens)) {
          const inputEst = countMessagesTokens(attemptRequest.messages);
          const outputEst = countResponseTokens(outcome.buffered);
          finalUsage = { inputTokens: inputEst, outputTokens: outputEst, totalTokens: inputEst + outputEst };
        }
        usageCache.observe(ctx.sessionId, finalUsage);
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
      yield { type: "error", error: lastError };
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
    return { previousTier, orchestrating };
  }

  return {
    decide,
    execute,
    stream,
    invalidateSticky,
    observeUsage(sessionId, usage) {
      if (!enabled) return;
      usageCache.observe(sessionId, usage);
    },
    stats,
    async shutdown() {
      await stats.flush();
      stats.dispose();
      disposeTokenizer();
      if (!externalStore) sessionStore.clear();
      usageCache.clear();
      healthTrackers.clear();
    },
  };
}

type AttemptPlan = {
  attempt: RouterModelRef;
  downgradeUnsupportedMedia: boolean;
};

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
  abortSignal?: AbortSignal,
): AsyncGenerator<
  | { kind: "event"; event: CanonicalModelEvent }
  | { kind: "outcome"; outcome: AttemptOutcome }
> {
  const buffered: CanonicalModelEvent[] = [];
  const state = createZeroUsageState();
  let providerError: import("../model/index.js").CanonicalModelError | undefined;

  try {
    for await (const event of modelRuntime.stream(request, { signal: abortSignal })) {
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

function isMidStreamRateLimitError(error: import("../model/index.js").CanonicalModelError): boolean {
  return error.code === "rate_limit_error" || error.code === "overloaded_error";
}

function classifyRetryReason(errorCode: string): "rate_limit" | "server_error" | "network_error" | "zero_usage" | "overloaded" {
  if (errorCode === "rate_limit_error") return "rate_limit";
  if (errorCode === "overloaded_error") return "overloaded";
  if (errorCode === "server_error") return "server_error";
  if (errorCode === "network_error" || errorCode === "timeout") return "network_error";
  return "server_error";
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

function extractPartialText(buffered: CanonicalModelEvent[]): string {
  let text = "";
  for (const ev of buffered) {
    if (ev.type === "text_delta") {
      text += ev.text;
    }
  }
  return text;
}

const MID_STREAM_CONTINUATION_MARKER = "Continue from where you left off.";

function buildMidStreamContinuationRequest(
  original: CanonicalModelRequest,
  partialText: string,
): CanonicalModelRequest {
  const baseMessages = stripPriorContinuation(original.messages);
  return {
    ...original,
    messages: [
      ...baseMessages,
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: partialText }],
      },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: MID_STREAM_CONTINUATION_MARKER }],
      },
    ],
  };
}

function stripPriorContinuation(messages: CanonicalModelRequest["messages"]): CanonicalModelRequest["messages"] {
  if (messages.length < 2) return messages;
  const last = messages[messages.length - 1];
  const secondLast = messages[messages.length - 2];
  if (
    last.role === "user" &&
    secondLast.role === "assistant" &&
    last.content.length === 1 &&
    last.content[0].type === "text" &&
    (last.content[0] as { type: "text"; text: string }).text === MID_STREAM_CONTINUATION_MARKER
  ) {
    return messages.slice(0, -2);
  }
  return messages;
}
