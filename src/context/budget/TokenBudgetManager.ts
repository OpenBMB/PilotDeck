import {
  flattenToolResultBlockText,
  type CanonicalContentBlock,
  type CanonicalMessage,
} from "../../model/index.js";
import { countTokens } from "./tokenizer.js";

export type TokenWarningState = "ok" | "warning" | "blocking";

export type TokenBudgetSnapshot = {
  tokens: number;
  maxContextTokens: number;
  warningRatio: number;
  blockingRatio: number;
  state: TokenWarningState;
  ratio: number;
};

export type TokenBudgetManagerOptions = {
  /** Fixed token count for image / pdf / audio blocks (default 2000). */
  multimediaTokens?: number;
  /** Auto-compact / warning threshold (default 0.8). */
  warningRatio?: number;
  /** Hard blocking threshold (default 0.95). */
  blockingRatio?: number;
  /** Per-message overhead for role/wrapper boilerplate (default 4 tokens). */
  perMessageOverhead?: number;
};

/**
 * IMAGE_MAX_TOKEN_SIZE — exported so callers (compaction, projection) can
 * reason about the upper bound without instantiating a manager.
 */
export const IMAGE_MAX_TOKEN_SIZE = 2_000;
const DEFAULT_WARNING_RATIO = 0.8;
const DEFAULT_BLOCKING_RATIO = 0.95;
const DEFAULT_PER_MESSAGE_OVERHEAD = 4;

/**
 * Padding factor applied by `estimateForMessagesWithPadding`. Multiplies
 * by 4/3 to reserve headroom for drift between our tiktoken estimator
 * and the provider's actual tokenizer.
 */
const ROUGH_PADDING_NUMERATOR = 4;
const ROUGH_PADDING_DENOMINATOR = 3;

/**
 * Token budget estimator backed by o200k_base tiktoken encoding.
 *
 * Text / code / tool argument blocks are measured with the real BPE
 * tokenizer via `countTokens()` from `./tokenizer.js`. Multimedia
 * blocks (image, pdf, audio) still use a fixed placeholder size
 * (IMAGE_MAX_TOKEN_SIZE = 2000).
 */
export class TokenBudgetManager {
  private readonly multimediaTokens: number;
  private readonly warningRatio: number;
  private readonly blockingRatio: number;
  private readonly perMessageOverhead: number;

  constructor(options: TokenBudgetManagerOptions = {}) {
    this.multimediaTokens = options.multimediaTokens ?? IMAGE_MAX_TOKEN_SIZE;
    this.warningRatio = options.warningRatio ?? DEFAULT_WARNING_RATIO;
    this.blockingRatio = options.blockingRatio ?? DEFAULT_BLOCKING_RATIO;
    this.perMessageOverhead = options.perMessageOverhead ?? DEFAULT_PER_MESSAGE_OVERHEAD;
  }

  /**
   * Token count via o200k_base tiktoken encoding. Replaces the legacy
   * char/4 estimator for substantially better accuracy, especially with
   * non-ASCII content (CJK characters, code, JSON).
   */
  estimateTextTokens(text: string): number {
    return countTokens(text);
  }

  /**
   * Estimate tokens for raw file content. Now delegates to tiktoken
   * regardless of file extension (the tokenizer handles encoding
   * density natively). The ext parameter is retained for API compat.
   */
  estimateForFileType(content: string, _ext: string | null | undefined): number {
    return countTokens(content);
  }

  /** T4: per-block estimate. Public alias retained for legacy callers. */
  estimateBlockTokens(block: CanonicalContentBlock): number {
    return this.estimateForBlock(block);
  }

  estimateForBlock(block: CanonicalContentBlock): number {
    switch (block.type) {
      case "text":
        // T1 leaf application.
        return this.estimateTextTokens(block.text);
      case "thinking":
        // T5: text only; signature is provider-opaque metadata.
        return this.estimateTextTokens(block.text);
      case "image":
        // T6.
        return this.multimediaTokens;
      case "pdf":
        // T7.
        return this.multimediaTokens;
      case "audio":
        // T8: PilotDeck-specific. Legacy lacks audio blocks
        // (intentional_difference, see §4.2 footnote).
        return this.multimediaTokens;
      case "tool_call": {
        // T9: legacy concatenates name + JSON args before counting.
        const serialized = `${block.name}${safeJsonStringify(block.input)}`;
        return this.estimateTextTokens(serialized);
      }
      case "tool_result":
        // T10: count text plus stable placeholders for visual tool output.
        return this.estimateTextTokens(flattenToolResultBlockText(block));
      case "tool_result_reference":
        // T13: PilotDeck-only block; preview only.
        return this.estimateTextTokens(block.preview);
    }
  }

  /** T11: per-message estimate including overhead. */
  estimateForMessage(message: CanonicalMessage): number {
    let total = this.perMessageOverhead;
    for (const block of message.content) {
      total += this.estimateForBlock(block);
    }
    return total;
  }

  /**
   * Sum of `estimateForMessage` across every message. Backwards-compat
   * alias `estimateMessagesTokens` is kept — both now use the same
   * per-message accounting (overhead included).
   */
  estimateForMessages(messages: CanonicalMessage[]): number {
    let total = 0;
    for (const message of messages) {
      total += this.estimateForMessage(message);
    }
    return total;
  }

  estimateMessagesTokens(messages: CanonicalMessage[]): number {
    return this.estimateForMessages(messages);
  }

  /**
   * T12: padded estimate (4/3 multiplier, ceil) used by warning / compaction
   * gates. Conservative upper bound that survives drift between our
   * estimator and the provider's tokenizer.
   */
  estimateForMessagesWithPadding(messages: CanonicalMessage[]): number {
    const raw = this.estimateForMessages(messages);
    if (raw === 0) return 0;
    return Math.ceil((raw * ROUGH_PADDING_NUMERATOR) / ROUGH_PADDING_DENOMINATOR);
  }

  evaluate(messages: CanonicalMessage[], maxContextTokens: number): TokenBudgetSnapshot {
    const tokens = this.estimateMessagesTokens(messages);
    const ratio = maxContextTokens > 0 ? tokens / maxContextTokens : 0;
    let state: TokenWarningState = "ok";
    if (ratio >= this.blockingRatio) {
      state = "blocking";
    } else if (ratio >= this.warningRatio) {
      state = "warning";
    }
    return {
      tokens,
      maxContextTokens,
      warningRatio: this.warningRatio,
      blockingRatio: this.blockingRatio,
      state,
      ratio,
    };
  }
}

/**
 * Stable JSON for token counting. Returns "" for undefined / null / circular
 * inputs (legacy: an unset tool_use input still costs the name string only).
 */
function safeJsonStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
