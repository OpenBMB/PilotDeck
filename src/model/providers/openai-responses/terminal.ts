import type { CanonicalFinishReason } from "../../protocol/canonical.js";
import type { CanonicalModelError } from "../../protocol/errors.js";
import { normalizeModelError } from "../../errors/normalizeModelError.js";

const TRANSIENT_CODES = new Set([
  "server_is_overloaded",
  "slow_down",
  "rate_limit_exceeded",
]);

const TERMINAL_CODES = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "authentication_error",
  "invalid_api_key",
  "invalid_request_error",
]);

export type OpenAIResponsesTerminal = {
  finishReason: CanonicalFinishReason;
  error?: CanonicalModelError;
};

export type OpenAIResponsesTerminalOptions = {
  provider?: string;
  sawToolCall?: boolean;
};

/** Classify the terminal state shared by Responses streaming and non-streaming adapters. */
export function classifyOpenAIResponsesTerminal(
  raw: unknown,
  options: OpenAIResponsesTerminalOptions = {},
): OpenAIResponsesTerminal {
  const outer = asRecord(raw);
  const nestedResponse = asRecord(outer.response);
  const response = Object.keys(nestedResponse).length > 0 ? nestedResponse : outer;
  const status = readString(response.status) ?? statusFromEventType(readString(outer.type));

  if (status === "completed") {
    return { finishReason: options.sawToolCall ? "tool_call" : "stop" };
  }
  if (status === "incomplete") {
    return { finishReason: classifyIncompleteReason(response) };
  }
  if (status === "failed" || status === "cancelled") {
    return {
      finishReason: "error",
      error: responsesTerminalError(raw, options.provider),
    };
  }
  if (readString(outer.type) === "error") {
    return {
      finishReason: "error",
      error: responsesTerminalError(raw, options.provider),
    };
  }
  return { finishReason: "unknown" };
}

export function responsesTerminalError(
  raw: unknown,
  provider = "openai-responses",
): CanonicalModelError {
  const outer = asRecord(raw);
  const response = asRecord(outer.response);
  const responseError = asRecord(response.error);
  const eventError = asRecord(outer.error);
  const error = Object.keys(responseError).length > 0
    ? responseError
    : Object.keys(eventError).length > 0
      ? eventError
      : response;
  const code = readString(error.code) ?? readString(error.type) ?? "provider_error";
  const message = readString(error.message) ?? terminalFallbackMessage(response, outer);
  const status = readHttpStatus(error.status) ?? readHttpStatus(outer.status);
  const normalized = normalizeModelError(provider, "openai-responses", { error }, status);

  return {
    ...normalized,
    provider,
    protocol: "openai-responses",
    code,
    message,
    status,
    retryable: retryability(code, normalized.retryable),
    raw,
  };
}

function classifyIncompleteReason(response: Record<string, unknown>): CanonicalFinishReason {
  const details = asRecord(response.incomplete_details);
  const reason = (readString(details.reason) ?? readString(response.reason) ?? "").toLowerCase();
  if (/content[_ -]?filter|safety|policy|moderation/.test(reason)) {
    return "content_filter";
  }
  if (/max(?:imum)?[_ -]?(?:output[_ -]?)?tokens?|token[_ -]?limit|length/.test(reason)) {
    return "length";
  }
  return "unknown";
}

function retryability(code: string, canonicalRetryable: boolean): boolean {
  const normalizedCode = code.toLowerCase();
  if (TRANSIENT_CODES.has(normalizedCode)) return true;
  if (TERMINAL_CODES.has(normalizedCode)) return false;
  if (/quota|billing|auth|permission|invalid[_ -]?(?:request|api[_ -]?key)/.test(normalizedCode)) return false;
  return canonicalRetryable;
}

function terminalFallbackMessage(
  response: Record<string, unknown>,
  outer: Record<string, unknown>,
): string {
  const status = readString(response.status) ?? statusFromEventType(readString(outer.type));
  return status === "cancelled"
    ? "OpenAI Responses request was cancelled."
    : "OpenAI Responses request failed.";
}

function statusFromEventType(type: string | undefined): string | undefined {
  if (!type?.startsWith("response.")) return undefined;
  return type.slice("response.".length);
}

function readHttpStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
