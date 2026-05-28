import type { CanonicalModelError } from "../../model/index.js";
import type { ContextRecoveryDecision } from "../protocol/types.js";

export type ContextOverflowRecoveryOptions = {
  truncateFirstKeepRatio?: number;
  truncateSecondKeepRatio?: number;
};

const DEFAULT_FIRST_KEEP = 0.5;
const DEFAULT_SECOND_KEEP = 0.25;

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
    if (input.error.code !== "prompt_too_long") {
      return { type: "give_up", reason: `non_recoverable_model_error:${input.error.code}` };
    }
    if (input.hasAttemptedCompact) {
      return { type: "give_up", reason: "ptl-exhausted-after-two-attempts" };
    }
    return { type: "truncate_head_and_retry", keepRatio: this.first, reason: "ptl-first-attempt" };
  }
}
