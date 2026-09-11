import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalUsage,
  ModelRuntime,
} from "../../model/index.js";
import { ModelProviderError, ModelRequestError } from "../../model/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import {
  DEFAULT_TOKEN_SAVER_CONTEXT,
  type RouterModelRef,
  type RouterTokenSaverConfig,
} from "../config/schema.js";
import {
  buildJudgeContext,
  detectExplicitRiskTier,
  isShortContinuation,
  type ContinuationKind,
  type JudgeContext,
} from "./buildJudgeContext.js";
import { generateJudgePrompt, generateJudgeSystemPrompt } from "./generateJudgePrompt.js";
import {
  parseJudgeDecision,
  parseJudgeDecisionFromThinking,
  type JudgeTaskRelation,
} from "./parseJudgeDecision.js";

export type TokenSaverResolution =
  | "judge"
  | "continuation_gate"
  | "risk_gate"
  | "relation_guard"
  | "confidence_guard"
  | "default"
  | "fallback";

export type TokenSaverRoutingDiagnostics = {
  resolution: TokenSaverResolution;
  judgeInvoked: boolean;
  judgeAttempts: number;
  judgeLatencyMs: number;
  judgeProposedTier?: string;
  judgeResponseSource?: "text" | "thinking";
  judgeFinishReason?: string;
  judgeConfidence?: number;
  judgeUsage?: CanonicalUsage;
  taskRelation?: JudgeTaskRelation;
  continuationKind: ContinuationKind;
  previousTierAvailable: boolean;
  context: {
    messageCount: number;
    userMessageCount: number;
    toolCallCount: number;
    toolResultCount: number;
    failedToolResultCount: number;
    mediaCount: number;
    textCharacterCount: number;
    availableToolCount: number;
    currentMessageChars: number;
    previousTaskChars: number;
    assistantTailChars: number;
    hasNewTaskSignal: boolean;
  };
};

export type TokenSaverDecision = {
  tier: string;
  selection: RouterModelRef;
  resolvedFrom: TokenSaverResolution;
  diagnostics?: TokenSaverRoutingDiagnostics;
  failureReason?: "timeout" | "model_error" | "parse_error";
  /** Diagnostic safe to persist in router events when classification falls back. */
  failure?: TokenSaverFailure;
};

export type TokenSaverFailure = {
  reason: NonNullable<TokenSaverDecision["failureReason"]>;
  attempts: number;
  /** Provider-normalized code when the judge request reached a provider. */
  code?: string;
  /** Sanitized provider message; never includes request content or credentials. */
  message?: string;
};

export type ClassifyAndRouteInput = {
  config: RouterTokenSaverConfig;
  messages: CanonicalMessage[];
  judgeRuntime: ModelRuntime;
  abortSignal?: AbortSignal;
  /** Tier from the previous turn; used by continuation and uncertainty guards. */
  previousTier?: string;
  availableToolCount?: number;
  sessionId?: string;
  telemetry?: TelemetryClient;
};

export async function classifyAndRoute(
  input: ClassifyAndRouteInput,
): Promise<TokenSaverDecision | undefined> {
  const { config } = input;
  if (!config.enabled) return undefined;

  const defaultTier = config.tiers[config.defaultTier];
  if (!defaultTier) return undefined;

  const contextConfig = { ...DEFAULT_TOKEN_SAVER_CONTEXT, ...config.contextAware };
  const context = buildJudgeContext({
    messages: input.messages,
    previousTier: input.previousTier,
    availableToolCount: input.availableToolCount,
    options: {
      maxCurrentMessageChars: contextConfig.maxCurrentMessageChars,
      maxPreviousTaskChars: contextConfig.maxPreviousTaskChars,
      maxAssistantTailChars: contextConfig.maxAssistantTailChars,
    },
  });
  if (!context) {
    return {
      tier: config.defaultTier,
      selection: defaultTier.model,
      resolvedFrom: "default",
    };
  }

  const judgeContext = contextConfig.enabled ? context : currentMessageOnlyContext(context);
  const previousTier = input.previousTier && config.tiers[input.previousTier]
    ? input.previousTier
    : undefined;

  if (
    contextConfig.enabled &&
    contextConfig.continuationGate &&
    previousTier &&
    !context.hasNewTaskSignal &&
    (context.continuationKind === "action" || context.continuationKind === "action_confirmation")
  ) {
    input.telemetry?.trackFeatureLoopStage({
      module: "router",
      ownerModule: "router",
      executionKind: "router_judge",
      phase: "judge",
      loopStage: "module_event",
      outcome: "success",
      sessionId: input.sessionId,
      metadata: {
        event: "judge_skipped_continuation",
        tier: previousTier,
        continuationKind: context.continuationKind,
      },
    });
    return {
      tier: previousTier,
      selection: config.tiers[previousTier]!.model,
      resolvedFrom: "continuation_gate",
      diagnostics: diagnosticsFor(context, {
        resolution: "continuation_gate",
        judgeInvoked: false,
      }),
    };
  }

  const explicitRiskTier = contextConfig.enabled
    ? detectExplicitRiskTier(context.currentUserMessage)
    : undefined;
  if (explicitRiskTier && config.tiers[explicitRiskTier]) {
    input.telemetry?.trackFeatureLoopStage({
      module: "router",
      ownerModule: "router",
      executionKind: "router_judge",
      phase: "judge",
      loopStage: "module_event",
      outcome: "success",
      sessionId: input.sessionId,
      metadata: {
        event: "judge_skipped_explicit_risk",
        tier: explicitRiskTier,
      },
    });
    return {
      tier: explicitRiskTier,
      selection: config.tiers[explicitRiskTier]!.model,
      resolvedFrom: "risk_gate",
      diagnostics: diagnosticsFor(context, {
        resolution: "risk_gate",
        judgeInvoked: false,
      }),
    };
  }

  const knownTiers = Object.keys(config.tiers);
  const userPrompt = generateJudgePrompt(judgeContext);
  const judgeRequest: CanonicalModelRequest = {
    provider: config.judge.provider,
    model: config.judge.model,
    systemPrompt: generateJudgeSystemPrompt(config),
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
    maxOutputTokens: 128,
    // Provider defaults are more compatible than an explicit temperature for
    // lightweight routing requests. Some compatible gateways reject it.
    thinking: judgeThinkingConfig(input.judgeRuntime, config.judge),
    stream: false,
  };

  const timeoutMs = Math.max(500, config.judgeTimeoutMs ?? 5_000);
  const maxAttempts = 3;
  const judgeStartedAt = Date.now();
  let judgeUsage: CanonicalUsage | undefined;

  input.telemetry?.trackFeatureLoopStage({
    module: "router",
    ownerModule: "router",
    executionKind: "router_judge",
    phase: "judge",
    loopStage: "module_event",
    outcome: "success",
    sessionId: input.sessionId,
    metadata: {
      event: "judge_enabled",
      provider: config.judge.provider,
      model: config.judge.model,
      contextChars: userPrompt.length,
      previousTierAvailable: Boolean(previousTier),
      continuationKind: context.continuationKind,
    },
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    const judgeAbortController = new AbortController();
    const forwardAbort = () => judgeAbortController.abort(input.abortSignal?.reason);
    input.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.abortSignal?.aborted) forwardAbort();

    try {
      input.telemetry?.trackFeatureLoopStage({
        module: "router",
        ownerModule: "router",
        executionKind: "router_judge",
        phase: "judge",
        loopStage: "model_request",
        outcome: "success",
        sessionId: input.sessionId,
        metadata: {
          event: "request_started",
          attempt,
          provider: config.judge.provider,
          model: config.judge.model,
        },
      });
      const response = await Promise.race([
        input.judgeRuntime.complete(judgeRequest, { signal: judgeAbortController.signal }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            const timeoutError = new TokenSaverTimeoutError();
            judgeAbortController.abort(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
        }),
      ]);
      judgeUsage = addUsage(judgeUsage, response.usage);
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const thinking = response.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.text)
        .join("\n");

      const parsedFromText = text ? parseJudgeDecision(text, knownTiers) : undefined;
      const parsed = parsedFromText
        ?? (thinking ? parseJudgeDecisionFromThinking(thinking, knownTiers) : undefined);
      const responseSource = parsedFromText ? "text" : parsed ? "thinking" : undefined;
      if (!parsed) {
        if (attempt < maxAttempts) continue;
        input.telemetry?.trackFeatureLoopStage({
          module: "router",
          ownerModule: "router",
          executionKind: "router_judge",
          phase: "judge",
          loopStage: "model_response",
          outcome: "failed",
          errorCategory: "runtime_error",
          sessionId: input.sessionId,
          metadata: {
            event: "parse_failed",
            attempt,
            provider: config.judge.provider,
            model: config.judge.model,
          },
        });
        return fallbackDecision({
          config,
          defaultTier,
          context,
          attempt,
          judgeStartedAt,
          judgeUsage,
          failureReason: "parse_error",
        });
      }

      const guarded = applyUncertaintyGuard({
        parsed,
        context,
        previousTier,
        defaultTier: config.defaultTier,
        tierOrder: knownTiers,
        confidenceThreshold: contextConfig.confidenceThreshold,
      });
      const selection = config.tiers[guarded.tier]?.model;
      if (!selection) {
        return fallbackDecision({
          config,
          defaultTier,
          context,
          attempt,
          judgeStartedAt,
          judgeUsage,
          failureReason: "parse_error",
        });
      }

      input.telemetry?.trackFeatureLoopStage({
        module: "router",
        ownerModule: "router",
        executionKind: "router_judge",
        phase: "judge",
        loopStage: "model_response",
        outcome: "success",
        sessionId: input.sessionId,
        metadata: {
          event: "request_succeeded",
          attempt,
          tier: guarded.tier,
          proposedTier: parsed.tier,
          confidence: parsed.confidence,
          taskRelation: parsed.taskRelation,
          resolution: guarded.resolution,
          responseSource,
          finishReason: response.finishReason,
          provider: config.judge.provider,
          model: config.judge.model,
        },
      });
      return {
        tier: guarded.tier,
        selection,
        resolvedFrom: guarded.resolution,
        diagnostics: diagnosticsFor(context, {
          resolution: guarded.resolution,
          judgeInvoked: true,
          judgeAttempts: attempt,
          judgeLatencyMs: Date.now() - judgeStartedAt,
          judgeProposedTier: parsed.tier,
          judgeResponseSource: responseSource,
          judgeFinishReason: response.finishReason,
          judgeConfidence: parsed.confidence,
          judgeUsage,
          taskRelation: parsed.taskRelation,
        }),
      };
    } catch (error) {
      if (input.abortSignal?.aborted) throw error;
      const failure = timedOut ? new TokenSaverTimeoutError() : error;
      if (attempt < maxAttempts && shouldRetryJudgeFailure(failure)) continue;
      const didTimeout = failure instanceof TokenSaverTimeoutError;
      input.telemetry?.trackError(error, {
        module: "router",
        ownerModule: "router",
        executionKind: "router_judge",
        phase: "judge",
        loopStage: "model_request",
        errorCategory: didTimeout ? "runtime_error" : "model_request_error",
        sessionId: input.sessionId,
        code: didTimeout ? "judge_timeout" : "judge_model_error",
        metadata: {
          event: didTimeout ? "timeout" : "request_failed",
          attempt,
          provider: config.judge.provider,
          model: config.judge.model,
        },
      });
      const failureReason = didTimeout ? "timeout" : "model_error";
      return {
        tier: config.defaultTier,
        selection: defaultTier.model,
        resolvedFrom: "fallback",
        failureReason,
        failure: didTimeout
          ? { reason: "timeout", attempts: attempt, code: "judge_timeout" }
          : describeFailure(failure, attempt),
        diagnostics: diagnosticsFor(context, {
          resolution: "fallback",
          judgeInvoked: true,
          judgeAttempts: attempt,
          judgeLatencyMs: Date.now() - judgeStartedAt,
          judgeUsage,
        }),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      input.abortSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  return fallbackDecision({
    config,
    defaultTier,
    context,
    attempt: maxAttempts,
    judgeStartedAt,
    judgeUsage,
    failureReason: "parse_error",
  });
}

function applyUncertaintyGuard(input: {
  parsed: NonNullable<ReturnType<typeof parseJudgeDecision>>;
  context: JudgeContext;
  previousTier?: string;
  defaultTier: string;
  tierOrder: string[];
  confidenceThreshold: number;
}): { tier: string; resolution: TokenSaverResolution } {
  const { parsed, context, previousTier } = input;
  if (
    parsed.taskRelation === "continuation" &&
    previousTier &&
    !context.hasNewTaskSignal &&
    tierRank(parsed.tier, input.tierOrder) < tierRank(previousTier, input.tierOrder)
  ) {
    return { tier: previousTier, resolution: "relation_guard" };
  }

  const lowConfidence = parsed.confidence !== undefined && parsed.confidence < input.confidenceThreshold;
  if (!lowConfidence) return { tier: parsed.tier, resolution: "judge" };

  const candidates = [parsed.tier, input.defaultTier];
  if (
    previousTier &&
    !context.hasNewTaskSignal &&
    (parsed.taskRelation === "continuation" ||
      parsed.taskRelation === "unclear" ||
      context.continuationKind === "acknowledgement")
  ) candidates.push(previousTier);
  return {
    tier: candidates.reduce((highest, tier) =>
      tierRank(tier, input.tierOrder) > tierRank(highest, input.tierOrder) ? tier : highest),
    resolution: "confidence_guard",
  };
}

function tierRank(tier: string, tierOrder: string[]): number {
  const standardRanks: Record<string, number> = {
    simple: 0,
    medium: 1,
    complex: 2,
    reasoning: 3,
  };
  return standardRanks[tier] ?? Math.max(0, tierOrder.indexOf(tier));
}

function currentMessageOnlyContext(context: JudgeContext): JudgeContext {
  return {
    currentUserMessage: context.currentUserMessage,
    continuationKind: "none",
    hasNewTaskSignal: context.hasNewTaskSignal,
    features: {
      ...context.features,
      messageCount: 1,
      userMessageCount: 1,
      assistantMessageCount: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      failedToolResultCount: 0,
      mediaCount: 0,
      textCharacterCount: context.currentUserMessage.length,
    },
  };
}

function diagnosticsFor(
  context: JudgeContext,
  input: {
    resolution: TokenSaverResolution;
    judgeInvoked: boolean;
    judgeAttempts?: number;
    judgeLatencyMs?: number;
    judgeProposedTier?: string;
    judgeResponseSource?: "text" | "thinking";
    judgeFinishReason?: string;
    judgeConfidence?: number;
    judgeUsage?: CanonicalUsage;
    taskRelation?: JudgeTaskRelation;
  },
): TokenSaverRoutingDiagnostics {
  return {
    resolution: input.resolution,
    judgeInvoked: input.judgeInvoked,
    judgeAttempts: input.judgeAttempts ?? 0,
    judgeLatencyMs: input.judgeLatencyMs ?? 0,
    ...(input.judgeProposedTier ? { judgeProposedTier: input.judgeProposedTier } : {}),
    ...(input.judgeResponseSource ? { judgeResponseSource: input.judgeResponseSource } : {}),
    ...(input.judgeFinishReason ? { judgeFinishReason: input.judgeFinishReason } : {}),
    ...(input.judgeConfidence === undefined ? {} : { judgeConfidence: input.judgeConfidence }),
    ...(input.judgeUsage ? { judgeUsage: input.judgeUsage } : {}),
    ...(input.taskRelation ? { taskRelation: input.taskRelation } : {}),
    continuationKind: context.continuationKind,
    previousTierAvailable: Boolean(context.previousTier),
    context: {
      messageCount: context.features.messageCount,
      userMessageCount: context.features.userMessageCount,
      toolCallCount: context.features.toolCallCount,
      toolResultCount: context.features.toolResultCount,
      failedToolResultCount: context.features.failedToolResultCount,
      mediaCount: context.features.mediaCount,
      textCharacterCount: context.features.textCharacterCount,
      availableToolCount: context.features.availableToolCount,
      currentMessageChars: context.currentUserMessage.length,
      previousTaskChars: context.previousTaskMessage?.length ?? 0,
      assistantTailChars: context.previousAssistantTail?.length ?? 0,
      hasNewTaskSignal: context.hasNewTaskSignal,
    },
  };
}

function fallbackDecision(input: {
  config: RouterTokenSaverConfig;
  defaultTier: RouterTokenSaverConfig["tiers"][string];
  context: JudgeContext;
  attempt: number;
  judgeStartedAt: number;
  judgeUsage?: CanonicalUsage;
  failureReason: "parse_error";
}): TokenSaverDecision {
  return {
    tier: input.config.defaultTier,
    selection: input.defaultTier.model,
    resolvedFrom: "fallback",
    failureReason: input.failureReason,
    failure: { reason: input.failureReason, attempts: input.attempt },
    diagnostics: diagnosticsFor(input.context, {
      resolution: "fallback",
      judgeInvoked: true,
      judgeAttempts: input.attempt,
      judgeLatencyMs: Date.now() - input.judgeStartedAt,
      judgeUsage: input.judgeUsage,
    }),
  };
}

class TokenSaverTimeoutError extends Error {
  readonly name = "TokenSaverTimeoutError";
}

function describeFailure(error: unknown, attempts: number): TokenSaverFailure {
  if (error instanceof TokenSaverTimeoutError) {
    return { reason: "timeout", attempts, code: "judge_timeout" };
  }
  const modelError = error instanceof ModelProviderError
    ? error.error
    : error instanceof ModelRequestError
      ? { code: error.code, message: error.message }
      : error instanceof Error
        ? { message: error.message }
        : undefined;
  return {
    reason: "model_error",
    attempts,
    ...(modelError?.code ? { code: modelError.code } : {}),
    ...(modelError?.message ? { message: sanitizeFailureMessage(modelError.message) } : {}),
  };
}

function shouldRetryJudgeFailure(error: unknown): boolean {
  if (error instanceof TokenSaverTimeoutError || error instanceof ModelRequestError) return false;
  if (error instanceof ModelProviderError) return error.error.retryable;
  return true;
}

function sanitizeFailureMessage(message: string): string {
  return message
    .replace(/\b(authorization\s*[:=]\s*bearer\s+|bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function judgeThinkingConfig(
  runtime: ModelRuntime,
  judge: RouterModelRef,
): NonNullable<CanonicalModelRequest["thinking"]> {
  try {
    const capabilities = runtime.getCapabilities(judge.provider, judge.model) as {
      supportsThinkingExplicit?: boolean;
    };
    // Providers explicitly declaring that thinking controls are unsupported
    // may reject even an "off" parameter, so preserve their default request.
    if (capabilities.supportsThinkingExplicit === false) return { enabled: false };
  } catch {
    // Test doubles and late-bound providers may not expose capabilities. The
    // adapter may still honor an explicit off request. Providers can ignore it,
    // so the response parser also has a bounded thinking-block fallback.
  }
  return { enabled: false, mode: "off" };
}

function addUsage(
  accumulated: CanonicalUsage | undefined,
  current: CanonicalUsage | undefined,
): CanonicalUsage | undefined {
  if (!current) return accumulated;
  return {
    inputTokens: (accumulated?.inputTokens ?? 0) + (current.inputTokens ?? 0),
    outputTokens: (accumulated?.outputTokens ?? 0) + (current.outputTokens ?? 0),
    cacheReadTokens: (accumulated?.cacheReadTokens ?? 0) + (current.cacheReadTokens ?? 0),
    cacheWriteTokens: (accumulated?.cacheWriteTokens ?? 0) + (current.cacheWriteTokens ?? 0),
    totalTokens: (accumulated?.totalTokens ?? 0) + (current.totalTokens ?? 0),
    nativeCost: (accumulated?.nativeCost ?? 0) + (current.nativeCost ?? 0),
  };
}

export { isShortContinuation };
