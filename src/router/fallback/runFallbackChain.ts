import type { CanonicalModelError } from "../../model/index.js";
import type { RouterFallbackConfig, RouterModelRef } from "../config/schema.js";
import type { RouterScenarioType } from "../protocol/decision.js";

export type FallbackPlan = {
  /** Provider/model pairs to try in order, after the initial decision. */
  attempts: RouterModelRef[];
};

export function planFallback(
  fallback: RouterFallbackConfig | undefined,
  scenarioType: RouterScenarioType | "explicit",
): FallbackPlan {
  if (!fallback) {
    return { attempts: [] };
  }

  if (scenarioType === "explicit") {
    return { attempts: fallback.default ?? [] };
  }

  return { attempts: (fallback as Record<string, RouterModelRef[] | undefined>)[scenarioType] ?? fallback.default ?? [] };
}

/**
 * Error codes that indicate the *model output* was malformed (e.g. invalid
 * JSON in tool arguments).  These are not retryable at the HTTP level
 * (resending the identical request won't help), but a same-model retry with
 * a corrective hint can let the model self-correct.
 */
const SELF_CORRECTABLE_CODES = new Set(["invalid_tool_arguments"]);

export function isFallbackEligible(error: CanonicalModelError): boolean {
  if (SELF_CORRECTABLE_CODES.has(error.code)) {
    return true;
  }
  if (!error.retryable) {
    return false;
  }
  if (error.recoverableViaCompact) {
    return false;
  }
  if (error.recoverableViaImageStrip) {
    return false;
  }
  if (error.code === "prompt_too_long" || error.code === "request_too_large") {
    return false;
  }
  return true;
}
