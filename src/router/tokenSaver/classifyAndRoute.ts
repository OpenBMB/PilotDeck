import type {
  CanonicalMessage,
  CanonicalModelRequest,
  ModelRuntime,
} from "../../model/index.js";
import { ModelProviderError, ModelRequestError } from "../../model/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { RouterModelRef, RouterTokenSaverConfig } from "../config/schema.js";
import { extractLastUserMessage } from "./extractLastUserMessage.js";
import { generateJudgePrompt } from "./generateJudgePrompt.js";
import { parseTier } from "./parseTier.js";

export type TokenSaverDecision = {
  tier: string;
  selection: RouterModelRef;
  resolvedFrom: "judge" | "default" | "fallback";
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
  /** Tier from the previous turn; passed to the judge for context-aware classification. */
  previousTier?: string;
  sessionId?: string;
  telemetry?: TelemetryClient;
};

export async function classifyAndRoute(
  input: ClassifyAndRouteInput,
): Promise<TokenSaverDecision | undefined> {
  const { config } = input;
  if (!config.enabled) {
    return undefined;
  }

  const defaultTier = config.tiers[config.defaultTier];
  if (!defaultTier) {
    return undefined;
  }

  const userMessage = extractLastUserMessage(input.messages);
  if (!userMessage) {
    return {
      tier: config.defaultTier,
      selection: defaultTier.model,
      resolvedFrom: "default",
    };
  }

  const knownTiers = Object.keys(config.tiers);
  const prompt = generateJudgePrompt({ userMessage, config, previousTier: input.previousTier });
  const judgeRequest: CanonicalModelRequest = {
    provider: config.judge.provider,
    model: config.judge.model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    ],
    maxOutputTokens: 256,
    // Provider defaults are more compatible than an explicit temperature for
    // lightweight routing requests. Some compatible gateways reject the
    // field for particular models (including Claude-backed ones).
    thinking: { enabled: false },
    stream: false,
  };

  const timeoutMs = Math.max(500, config.judgeTimeoutMs ?? 5_000);
  const maxAttempts = 3;
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
    },
  });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    const judgeAbortController = new AbortController();
    const forwardAbort = () => judgeAbortController.abort(input.abortSignal?.reason);
    input.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.abortSignal?.aborted) {
      forwardAbort();
    }
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
      const judgeRequestPromise = input.judgeRuntime.complete(judgeRequest, {
        signal: judgeAbortController.signal,
      });
      const response = await Promise.race([
        judgeRequestPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            const timeoutError = new TokenSaverTimeoutError();
            judgeAbortController.abort(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
        }),
      ]);
      console.log(
        `[token-saver] Judge raw content blocks (attempt ${attempt}):`,
        JSON.stringify(response.content).slice(0, 500),
        `| finishReason=${response.finishReason}`,
      );
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (!text) {
        if (attempt < maxAttempts) {
          continue;
        }
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
        console.warn("[token-saver] Judge returned empty after retries");
        return {
          tier: config.defaultTier,
          selection: defaultTier.model,
          resolvedFrom: "fallback",
          failureReason: "parse_error",
          failure: { reason: "parse_error", attempts: attempt },
        };
      }

      const tier = parseTier(text, knownTiers);
      if (!tier) {
        if (attempt < maxAttempts) {
          continue;
        }
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
        console.warn(
          "[token-saver] parseTier failed. Judge text:",
          JSON.stringify(text).slice(0, 300),
        );
        return {
          tier: config.defaultTier,
          selection: defaultTier.model,
          resolvedFrom: "fallback",
          failureReason: "parse_error",
          failure: { reason: "parse_error", attempts: attempt },
        };
      }
      const selection = config.tiers[tier]?.model;
      if (!selection) {
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
            tier,
            provider: config.judge.provider,
            model: config.judge.model,
          },
        });
        return {
          tier: config.defaultTier,
          selection: defaultTier.model,
          resolvedFrom: "fallback",
          failureReason: "parse_error",
          failure: { reason: "parse_error", attempts: attempt },
        };
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
          tier,
          provider: config.judge.provider,
          model: config.judge.model,
        },
      });
      return { tier, selection, resolvedFrom: "judge" };
    } catch (error) {
      if (input.abortSignal?.aborted) {
        throw error;
      }
      const failure = timedOut ? new TokenSaverTimeoutError() : error;
      if (attempt < maxAttempts && shouldRetryJudgeFailure(failure)) {
        continue;
      }
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
      return {
        tier: config.defaultTier,
        selection: defaultTier.model,
        resolvedFrom: "fallback",
        failureReason: didTimeout ? "timeout" : "model_error",
        failure: describeFailure(failure, attempt),
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      input.abortSignal?.removeEventListener("abort", forwardAbort);
    }
  }
  return {
    tier: config.defaultTier,
    selection: defaultTier.model,
    resolvedFrom: "fallback",
    failureReason: "parse_error",
    failure: { reason: "parse_error", attempts: maxAttempts },
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
  if (error instanceof TokenSaverTimeoutError || error instanceof ModelRequestError) {
    return false;
  }
  if (error instanceof ModelProviderError) {
    return error.error.retryable;
  }
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

const SHORT_CONTINUATION_MAX_CHARS = 30;

const CONTINUATION_PATTERNS = [
  /^(go|ok|yes|y|sure|do it|proceed|continue|next|done|start|run|好|好的|继续|开始|可以|行|嗯|对|是的|没问题|来吧|冲|走|执行|开搞|干|上)$/i,
];

/**
 * Detect short acknowledgment / continuation messages that should inherit the
 * previous turn's tier rather than being re-classified by the judge. Small LLMs
 * reliably mis-classify these as "simple" because they match the "confirmations"
 * tier description.
 */
export function isShortContinuation(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > SHORT_CONTINUATION_MAX_CHARS) {
    return false;
  }
  return CONTINUATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}
