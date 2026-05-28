import type {
  CanonicalMessage,
  CanonicalModelRequest,
  ModelRuntime,
} from "../../model/index.js";
import type { RouterModelRef, RouterTokenSaverConfig } from "../config/schema.js";
import { extractLastUserMessage } from "./extractLastUserMessage.js";
import { generateJudgePrompt } from "./generateJudgePrompt.js";
import { parseTier } from "./parseTier.js";

export type TokenSaverDecision = {
  tier: string;
  selection: RouterModelRef;
  resolvedFrom: "judge" | "default" | "fallback";
  failureReason?: "timeout" | "model_error" | "parse_error";
};

export type ClassifyAndRouteInput = {
  config: RouterTokenSaverConfig;
  messages: CanonicalMessage[];
  judgeRuntime: ModelRuntime;
  abortSignal?: AbortSignal;
  /** Tier from the previous turn; passed to the judge for context-aware classification. */
  previousTier?: string;
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
    temperature: 0,
    thinking: { enabled: false },
    stream: false,
  };

  const timeoutMs = Math.max(500, config.judgeTimeoutMs ?? 5_000);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      const response = await Promise.race([
        input.judgeRuntime.complete(judgeRequest),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new TokenSaverTimeoutError()), timeoutMs);
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
        console.warn("[token-saver] Judge returned empty after retries");
        return {
          tier: config.defaultTier,
          selection: defaultTier.model,
          resolvedFrom: "fallback",
          failureReason: "parse_error",
        };
      }

      const tier = parseTier(text, knownTiers);
      if (!tier) {
        if (attempt < maxAttempts) {
          continue;
        }
        console.warn(
          "[token-saver] parseTier failed. Judge text:",
          JSON.stringify(text).slice(0, 300),
        );
        return {
          tier: config.defaultTier,
          selection: defaultTier.model,
          resolvedFrom: "fallback",
          failureReason: "parse_error",
        };
      }
      const selection = config.tiers[tier]?.model;
      if (!selection) {
        return {
          tier: config.defaultTier,
          selection: defaultTier.model,
          resolvedFrom: "fallback",
          failureReason: "parse_error",
        };
      }
      return { tier, selection, resolvedFrom: "judge" };
    } catch (error) {
      if (attempt < maxAttempts && !(error instanceof TokenSaverTimeoutError)) {
        continue;
      }
      return {
        tier: config.defaultTier,
        selection: defaultTier.model,
        resolvedFrom: "fallback",
        failureReason: error instanceof TokenSaverTimeoutError ? "timeout" : "model_error",
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
  return {
    tier: config.defaultTier,
    selection: defaultTier.model,
    resolvedFrom: "fallback",
    failureReason: "parse_error",
  };
}

class TokenSaverTimeoutError extends Error {
  readonly name = "TokenSaverTimeoutError";
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
