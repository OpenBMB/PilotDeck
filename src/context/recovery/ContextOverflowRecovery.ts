import type { CanonicalModelError } from "../../model/index.js";
import type { ContextRecoveryDecision } from "../protocol/types.js";

export type ContextOverflowRecoveryOptions = {
  truncateFirstKeepRatio?: number;
  truncateSecondKeepRatio?: number;
};

const DEFAULT_FIRST_KEEP = 0.5;
const DEFAULT_SECOND_KEEP = 0.25;
const MIN_SAFE_AVAILABLE_OUTPUT_TOKENS = 4_096;

/**
 * Single-shot recovery decision (decision §3.1 #8). The first PTL within a
 * turn keeps the trailing 50%; the second keeps 25%; anything else
 * (including a third PTL) yields `give_up` and the loop must turn_failed.
 */
export class ContextOverflowRecovery {
  private readonly first: number;
  private readonly second: number;

  constructor(options: ContextOverflowRecoveryOptions = {}) {
    this.first = options.truncateFirstKeepRatio ?? DEFAULT_FIRST_KEEP;
    this.second = options.truncateSecondKeepRatio ?? DEFAULT_SECOND_KEEP;
  }

  decide(input: { error: CanonicalModelError; hasAttemptedCompact: boolean }): ContextRecoveryDecision {
    if (input.error.recoverableViaImageStrip) {
      return { type: "strip_images_and_retry", reason: "multimodal-processor-error" };
    }
    if (input.error.code === "image_too_large") {
      return { type: "strip_images_and_retry", reason: "image-too-large" };
    }
    if (input.error.availableOutputTokens !== undefined && input.error.availableOutputTokens > 0) {
      const available = Math.floor(input.error.availableOutputTokens);
      if (available < MIN_SAFE_AVAILABLE_OUTPUT_TOKENS && !input.hasAttemptedCompact) {
        return {
          type: "compact_and_retry",
          ...(input.error.maxContextTokens !== undefined && input.error.maxContextTokens > 0
            ? { maxContextTokens: Math.floor(input.error.maxContextTokens) }
            : {}),
          maxOutputTokens: MIN_SAFE_AVAILABLE_OUTPUT_TOKENS,
          reason: "provider-available-output-too-small",
        };
      }
      if (available < MIN_SAFE_AVAILABLE_OUTPUT_TOKENS && input.hasAttemptedCompact) {
        return { type: "truncate_head_and_retry", keepRatio: this.second, reason: "provider-available-output-too-small-after-compact" };
      }
      return {
        type: "adjust_output_and_retry",
        maxOutputTokens: Math.max(1, available),
        reason: "provider-output-cap",
        scope: "attempt",
      };
    }

    const parsedOutput = input.error.maxOutputTokens;
    if (parsedOutput !== undefined && parsedOutput > 0) {
      return {
        type: "adjust_output_and_retry",
        maxOutputTokens: Math.max(1, Math.floor(parsedOutput)),
        reason: "provider-output-cap",
        scope: "hard_cap",
      };
    }
    const isContextError =
      input.error.code === "prompt_too_long" ||
      input.error.code === "context_overflow" ||
      input.error.recoverableViaCompact === true;
    if (!isContextError) {
      return { type: "give_up", reason: `non_recoverable_model_error:${input.error.code}` };
    }
    if (input.hasAttemptedCompact) {
      return { type: "truncate_head_and_retry", keepRatio: this.second, reason: "ptl-second-attempt" };
    }
    if (input.error.maxContextTokens !== undefined && input.error.maxContextTokens > 0) {
      return {
        type: "compact_and_retry",
        maxContextTokens: Math.floor(input.error.maxContextTokens),
        reason: "provider-context-cap",
      };
    }
    return { type: "truncate_head_and_retry", keepRatio: this.first, reason: "ptl-first-attempt" };
  }
}
