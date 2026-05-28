import type { ModelProtocol } from "../protocol/canonical.js";
import {
  MAX_OUTPUT_REACHED_PATTERN,
  MULTIMODAL_PROCESSOR_PATTERN,
  PROMPT_TOO_LONG_ANTHROPIC_PATTERN,
  PROMPT_TOO_LONG_OPENAI_PATTERN,
  REQUEST_TOO_LARGE_PATTERN,
  type CanonicalModelError,
  type CanonicalModelErrorCode,
} from "../protocol/errors.js";

export function normalizeModelError(
  provider: string,
  protocol: ModelProtocol,
  error: unknown,
  status?: number,
): CanonicalModelError {
  const raw = error;
  const record = isRecord(error) ? error : undefined;
  const nestedError = record && isRecord(record.error) ? record.error : undefined;
  const source = nestedError ?? record;

  const message =
    readString(source?.message) ??
    (error instanceof Error ? error.message : undefined) ??
    "Model provider request failed.";

  const semanticCode = classifySemanticError(message, status, protocol);
  const code: CanonicalModelErrorCode | (string & {}) =
    semanticCode ?? readString(source?.code) ?? readString(source?.type) ?? statusCodeToCode(status);

  const result: CanonicalModelError = {
    provider,
    protocol,
    code,
    status,
    message,
    retryable: isRetryable(status, code),
    raw,
  };
  if (code === "prompt_too_long") {
    result.recoverableViaCompact = true;
  }
  if (MULTIMODAL_PROCESSOR_PATTERN.test(message)) {
    result.recoverableViaImageStrip = true;
  }
  return result;
}

function classifySemanticError(
  message: string,
  status: number | undefined,
  protocol: ModelProtocol,
): CanonicalModelErrorCode | undefined {
  // Legacy upstream matches "prompt is too long" case-insensitively for Anthropic and Vertex.
  if (PROMPT_TOO_LONG_ANTHROPIC_PATTERN.test(message)) {
    return "prompt_too_long";
  }
  // Legacy OpenAI withRetry path matches the standard OpenAI 400 message.
  if (PROMPT_TOO_LONG_OPENAI_PATTERN.test(message)) {
    return "prompt_too_long";
  }
  // Legacy splits "request too large" (PDF / body size) from PTL token overruns.
  if (REQUEST_TOO_LARGE_PATTERN.test(message)) {
    return "request_too_large";
  }
  if (MAX_OUTPUT_REACHED_PATTERN.test(message)) {
    return "max_output_reached";
  }
  if (status === 413) {
    // 413 with no PTL phrase is treated as request_too_large (Vertex pattern noted in legacy).
    return protocol === "anthropic" ? "request_too_large" : "request_too_large";
  }
  return undefined;
}

function isRetryable(status: number | undefined, code: string): boolean {
  if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  return ["rate_limit_error", "overloaded_error", "timeout", "server_error"].includes(code);
}

function statusCodeToCode(status: number | undefined): string {
  if (status === 401 || status === 403) {
    return "auth_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  if (status !== undefined && status >= 500) {
    return "server_error";
  }
  return "provider_error";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
