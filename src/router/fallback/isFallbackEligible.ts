import type { CanonicalModelError } from "../../model/index.js";

/**
 * Error codes that indicate the *model output* was malformed (e.g. invalid
 * JSON in tool arguments).  These are not retryable at the HTTP level
 * (resending the identical request won't help), but a same-model retry with
 * a corrective hint can let the model self-correct.
 */
const SELF_CORRECTABLE_CODES = new Set(["invalid_tool_arguments"]);

/**
 * Non-retryable error codes that should still attempt provider fallback
 * because a different provider may succeed (e.g. billing exhaustion on
 * one provider, model not found on another).
 */
const FALLBACK_ELIGIBLE_NON_RETRYABLE = new Set([
  "model_not_found",
  "auth_error",
]);

/** Failures tied to a shared endpoint or its credentials. A 403 can be model-specific. */
export function isProviderWideFailure(error: CanonicalModelError): boolean {
  return (error.code === "auth_error" && error.status !== 403)
    || error.code === "billing"
    || error.code === "dns_error"
    || error.code === "connection_refused"
    || error.code === "tls_error"
    || error.code === "proxy_error";
}

export function isFallbackEligible(error: CanonicalModelError): boolean {
  if (SELF_CORRECTABLE_CODES.has(error.code)) {
    return true;
  }
  if (isProviderWideFailure(error) || FALLBACK_ELIGIBLE_NON_RETRYABLE.has(error.code)) {
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
  if (error.code === "prompt_too_long" || error.code === "request_too_large" || error.code === "context_overflow") {
    return false;
  }
  return true;
}
