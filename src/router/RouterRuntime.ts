import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
} from "../model/index.js";
import {
  DEFAULT_SUBAGENT_MAX_TOKENS,
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
  createZeroUsageState,
  observeEventForZeroUsage,
  shouldRetryZeroUsage,
} from "./retry/zeroUsageRetry.js";
import { TokenStatsCollector } from "./stats/TokenStatsCollector.js";
import { classifyAndRoute } from "./tokenSaver/classifyAndRoute.js";
import { countMessagesTokens, countResponseTokens, dispose as disposeTokenizer } from "./utils/countTokens.js";

export type RouterRuntimeDeps = {
  modelRuntime: ModelRuntime;
  judgeRuntime?: ModelRuntime;
  customRouterRegistry?: CustomRouterRegistry;
  /** Optional skill prompt loader for AutoOrchestrate; receives extension id, returns text. */
  loadSkillPrompt?: (extensionId: string) => Promise<string | undefined>;
  events?: RouterEventBus;
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
  const stats = new TokenStatsCollector({
    ...config.stats,
    enabled: config.stats?.enabled ?? false,
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

    let skillPrompt: string | undefined;
    if (
      config.autoOrchestrate?.enabled &&
      orchGate &&
      input.isMainAgent &&
      config.autoOrchestrate.skillExtensionId &&
      deps.loadSkillPrompt
    ) {
      try {
        skillPrompt = await deps.loadSkillPrompt(config.autoOrchestrate.skillExtensionId);
      } catch {
        skillPrompt = undefined;
      }
    }

    let mutations: RouterMutationsLog = {};
    if (config.autoOrchestrate?.enabled && orchGate) {
      const orchestrated = applyOrchestration({
        request: input.request,
        config: config.autoOrchestrate,
        isMainAgent: input.isMainAgent,
        tier: tokenSaverTier,
        alreadyOrchestrating,
        skillPrompt,
      });
      if (orchestrated.applied) {
        mutations = { ...mutations, ...orchestrated.mutations };
        decision.requestPatch = {
          messages: orchestrated.request.messages,
          tools: orchestrated.request.tools,
          systemPrompt: orchestrated.request.systemPrompt,
        };
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
    return {
      ...request,
      ...decision.requestPatch,
      provider: decision.provider,
      model: decision.model,
      messages,
    };
  }

  async function* execute(
    decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext,
  ): AsyncIterable<CanonicalModelEvent> {
    const startedAt = (deps.now?.() ?? new Date()).toISOString();
    const fallbackPlan = planFallback(config.fallback, decision.scenarioType);
    const attempts: RouterModelRef[] = [
      { id: `${decision.provider}/${decision.model}`, provider: decision.provider, model: decision.model },
      ...fallbackPlan.attempts,
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

    outer: for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      if (ctx.abortSignal?.aborted) {
        return;
      }
      const attempt = attempts[attemptIndex];
      const attemptDecision: RouterDecision = {
        ...decision,
        provider: attempt.provider,
        model: attempt.model,
        resolvedFrom: attemptIndex === 0 ? decision.resolvedFrom : "fallback",
      };
      const attemptRequest = applyDecisionToRequest(attemptDecision, request);
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
          // Only retry/fallback if we haven't surfaced content yet — otherwise
          // we'd produce duplicate text on the consumer side.
          if (!hasYieldedContent && isFallbackEligible(outcome.error)) {
            if (attemptIndex < attempts.length - 1) {
              const next = attempts[attemptIndex + 1];
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
              continue outer;
            }
          }
          if (
            !hasYieldedContent &&
            isFallbackEligible(outcome.error) &&
            transientRetryEnabled &&
            transientRetryCount < transientRetryMax
          ) {
            const delay = Math.min(
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
            await abortableDelay(delay, ctx.abortSignal);
            transientRetryCount++;
            continue;
          }
          // Either we've already surfaced content, the error isn't eligible
          // for fallback/retry, or we've exhausted all retry attempts. Replay
          // any queued framing events then surface the error.
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
          await abortableDelay(500 * zeroUsageAttempt, ctx.abortSignal);
          continue;
        }

        // Success path: flush any pending framing events that didn't reach
        // a content event (e.g. zero-content responses, tool-only turns).
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
      usageCache.observe(sessionId, usage);
    },
    stats,
    async shutdown() {
      await stats.flush();
      stats.dispose();
      disposeTokenizer();
      if (!externalStore) sessionStore.clear();
      usageCache.clear();
    },
  };
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
    providerError = fromError ?? {
      provider: request.provider,
      protocol: "anthropic",
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

