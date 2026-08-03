import type { ModelProtocol } from "../protocol/canonical.js";
import { NetworkFetchError } from "../../network/fetch.js";
import {
  BILLING_PATTERN,
  CONTEXT_OVERFLOW_PATTERN,
  IMAGE_TOO_LARGE_PATTERN,
  MAX_OUTPUT_REACHED_PATTERN,
  MODEL_NOT_FOUND_PATTERN,
  MULTIMODAL_PROCESSOR_PATTERN,
  NETWORK_TIMEOUT_PATTERN,
  PROMPT_TOO_LONG_ANTHROPIC_PATTERN,
  PROMPT_TOO_LONG_OPENAI_PATTERN,
  RATE_LIMIT_MESSAGE_PATTERN,
  REQUEST_TOO_LARGE_PATTERN,
  TRANSIENT_USAGE_SIGNAL_PATTERN,
  USAGE_LIMIT_PATTERN,
  parseRetryAfterFromMessage,
  type CanonicalModelError,
  type CanonicalModelErrorCode,
  type SettingsFix,
} from "../protocol/errors.js";
import { parseTokenLimitError } from "./tokenLimitParsing.js";

export function normalizeModelError(
  provider: string,
  protocol: ModelProtocol,
  error: unknown,
  status?: number,
): CanonicalModelError {
  const raw = error;
  const record = firstErrorRecord(error);
  const nestedError = record && isRecord(record.error) ? record.error : undefined;
  const source = nestedError ?? record;

  const rawMessage =
    readString(source?.message) ??
    (error instanceof Error ? error.message : undefined) ??
    "Model provider request failed.";

  const message = sanitizeErrorMessage(rawMessage);

  const networkCode = classifyNetworkError(error, message);
  const semanticCode = classifySemanticError(message, status, protocol);
  const code: CanonicalModelErrorCode | (string & {}) =
    networkCode ?? semanticCode ?? readString(source?.code) ?? readString(source?.type) ?? statusCodeToCode(status, message);

  const hint = resolveUserHint(code, message, status, provider);

  const result: CanonicalModelError = {
    provider,
    protocol,
    code,
    status,
    message,
    retryable: isRetryable(status, code),
    raw,
    ...hint,
  };
  const tokenLimit = parseTokenLimitError(message);
  if (tokenLimit.maxContextTokens !== undefined) {
    result.maxContextTokens = tokenLimit.maxContextTokens;
  }
  if (tokenLimit.maxOutputTokens !== undefined) {
    result.maxOutputTokens = tokenLimit.maxOutputTokens;
  }
  if (tokenLimit.availableOutputTokens !== undefined) {
    result.availableOutputTokens = tokenLimit.availableOutputTokens;
  }
  if (code === "prompt_too_long" || code === "context_overflow") {
    result.recoverableViaCompact = true;
  }
  if (MULTIMODAL_PROCESSOR_PATTERN.test(message)) {
    result.recoverableViaImageStrip = true;
  }
  if (code === "image_too_large") {
    result.recoverableViaImageStrip = true;
  }
  const retryAfterMs = parseRetryAfterFromMessage(rawMessage);
  if (retryAfterMs !== undefined) {
    result.retryAfterMs = retryAfterMs;
  }
  return result;
}

function classifyNetworkError(error: unknown, message: string): CanonicalModelErrorCode | undefined {
  if (error instanceof NetworkFetchError) {
    switch (error.code) {
      case "network_dns_error":
        return "dns_error";
      case "network_connection_reset":
        return "connection_reset";
      case "network_connection_refused":
        return "connection_refused";
      case "network_tls_error":
        return "tls_error";
      case "network_proxy_error":
        return "proxy_error";
      case "network_rate_limited":
        return "rate_limit_error";
      case "network_server_error":
        return "server_error";
      case "network_timeout":
        return "timeout";
      default:
        return undefined;
    }
  }
  const text = message.toLowerCase();
  if (text.includes("enotfound") || text.includes("eai_again") || text.includes("dns")) return "dns_error";
  if (
    text.includes("econnreset")
    || text.includes("socket hang up")
    || /^(?:connection |stream )?terminated[.!]?$/u.test(text)
  ) return "connection_reset";
  if (text.includes("econnrefused")) return "connection_refused";
  if (text.includes("certificate") || text.includes("tls") || text.includes("ssl")) return "tls_error";
  if (text.includes("proxy connect") || text.includes("proxy error") || text.includes("tunnel") || text.includes("econnrefused proxy")) return "proxy_error";
  return undefined;
}

function firstErrorRecord(error: unknown): Record<string, unknown> | undefined {
  if (isRecord(error)) {
    return error;
  }
  if (!Array.isArray(error)) {
    return undefined;
  }
  return error.find(isRecord);
}

/**
 * Priority-ordered semantic classification pipeline.
 * Matches provider-agnostic error message patterns to canonical codes.
 */
function classifySemanticError(
  message: string,
  status: number | undefined,
  protocol: ModelProtocol,
): CanonicalModelErrorCode | undefined {
  if (PROMPT_TOO_LONG_ANTHROPIC_PATTERN.test(message)) {
    return "prompt_too_long";
  }
  if (PROMPT_TOO_LONG_OPENAI_PATTERN.test(message)) {
    return "prompt_too_long";
  }
  if (REQUEST_TOO_LARGE_PATTERN.test(message)) {
    return "request_too_large";
  }
  if (MAX_OUTPUT_REACHED_PATTERN.test(message)) {
    return "max_output_reached";
  }

  if (BILLING_PATTERN.test(message)) {
    return "billing";
  }
  if (RATE_LIMIT_MESSAGE_PATTERN.test(message)) {
    return "rate_limit_error";
  }
  if (IMAGE_TOO_LARGE_PATTERN.test(message)) {
    return "image_too_large";
  }
  if (MODEL_NOT_FOUND_PATTERN.test(message)) {
    return "model_not_found";
  }
  if (CONTEXT_OVERFLOW_PATTERN.test(message)) {
    return "context_overflow";
  }
  if (NETWORK_TIMEOUT_PATTERN.test(message)) {
    return "timeout";
  }

  if (status === 413) {
    return "payload_too_large";
  }
  return undefined;
}

function isRetryable(status: number | undefined, code: string): boolean {
  const nonRetryable = ["auth_error", "billing", "model_not_found", "invalid_request"];
  if (nonRetryable.includes(code)) {
    return false;
  }

  if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  return [
    "rate_limit_error",
    "overloaded_error",
    "timeout",
    "server_error",
    "dns_error",
    "connection_reset",
    "connection_refused",
    "proxy_error",
  ].includes(code);
}

/**
 * Map HTTP status to canonical code when message-based classification
 * didn't match. Includes 402 disambiguation: some providers return
 * transient usage-limit errors as 402 instead of 429.
 */
function statusCodeToCode(status: number | undefined, message?: string): string {
  if (status === 401 || status === 403) {
    return "auth_error";
  }
  if (status === 402) {
    const msg = message ?? "";
    if (BILLING_PATTERN.test(msg)) {
      return "billing";
    }
    if (USAGE_LIMIT_PATTERN.test(msg) && TRANSIENT_USAGE_SIGNAL_PATTERN.test(msg)) {
      return "rate_limit_error";
    }
    return "billing";
  }
  if (status === 404) {
    return "model_not_found";
  }
  if (status === 413) {
    return "payload_too_large";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  if (status !== undefined && status >= 500) {
    return "server_error";
  }
  return "provider_error";
}

/**
 * Generate user-facing actionable hints based on classified error code.
 */
function resolveUserHint(
  code: string,
  message: string,
  status?: number,
  provider?: string,
): { userHint?: string; settingsFix?: SettingsFix } {
  switch (code) {
    case "billing":
      return {
        userHint: `API account balance exhausted or quota depleted${provider ? ` for provider \"${provider}\"` : ""}. Top up provider billing or switch provider/model in Settings.`,
        settingsFix: {
          description: "Top up credits or switch to a different provider.",
          configPath: "model.provider",
        },
      };
    case "auth_error":
      return {
        userHint: `API key rejected${provider ? ` by provider \"${provider}\"` : " by the provider"}. Update the key in Settings → Model Provider or run pilotdeck setup.`,
        settingsFix: {
          description: "Reconfigure API key via setup.",
          command: "pilotdeck setup",
        },
      };
    case "model_not_found":
      return {
        userHint: `The requested model does not exist or your account lacks access${provider ? ` on provider \"${provider}\"` : ""}. Select a valid model in Settings → Model Provider or add it under model.providers.<id>.models in pilotdeck.yaml.`,
        settingsFix: {
          description: "Switch to a valid model.",
          configPath: "model.default",
        },
      };
    case "context_overflow":
    case "prompt_too_long":
      return {
        userHint: "Input exceeds the model context window. Run /compact, start a new session with /new, remove large attachments, or switch to a larger-context model in Settings.",
      };
    case "image_too_large":
      return {
        userHint: "Image exceeds the provider per-image size limit (typically 5 MB). Resize and retry.",
      };
    case "payload_too_large":
    case "request_too_large":
      return {
        userHint: "Request payload too large. Remove attachments, run /compact, start a new session with /new, or reduce the prompt size before retrying.",
      };
    case "rate_limit_error":
      return {
        userHint: "Rate limited by the provider. Wait for the limit to reset, reduce concurrent requests, or switch provider/model in Settings.",
      };
    case "overloaded_error":
      return {
        userHint: "Provider is temporarily overloaded. Retry later, check provider API status, or switch provider/model in Settings if it repeats.",
      };
    case "max_output_reached":
      return {
        userHint: "Model output hit the token limit. Increase max output tokens in Settings → Model Provider or ask the agent to split the answer into smaller parts.",
      };
    case "timeout":
      return {
        userHint: `Request timed out${provider ? ` for provider \"${provider}\"` : ""}. Increase provider.timeoutMs in Settings → Model Provider → Advanced, or check local network/proxy and provider status.`,
        settingsFix: {
          description: "Increase request timeout for this provider.",
          configPath: "model.providers.<id>.timeoutMs",
        },
      };
    case "server_error":
      return {
        userHint: "Provider returned a server error. Check provider API status/logs, retry later, or switch provider/model in Settings if it repeats.",
      };
    default:
      return {};
  }
}

/**
 * Clean raw error messages for user display:
 * - Extract <title> from Cloudflare / proxy HTML error pages
 * - Normalize whitespace
 * - Truncate overly long messages
 */
function sanitizeErrorMessage(raw: string): string {
  if (raw.includes("<!DOCTYPE") || raw.includes("<html")) {
    const match = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match?.[1]?.trim() ?? "Service temporarily unavailable (HTML error page returned).";
  }

  const cleaned = raw.replace(/\s+/g, " ").trim();
  return cleaned.length > 300 ? cleaned.slice(0, 297) + "..." : cleaned;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
