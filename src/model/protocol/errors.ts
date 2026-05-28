export type CanonicalModelErrorCode =
  | "prompt_too_long"
  | "request_too_large"
  | "max_output_reached"
  | "rate_limit_error"
  | "auth_error"
  | "server_error"
  | "timeout"
  | "overloaded_error"
  | "invalid_request"
  | "provider_error"
  | "unknown";

export type CanonicalModelError = {
  provider: string;
  protocol: "anthropic" | "openai";
  code: CanonicalModelErrorCode | (string & {});
  status?: number;
  message: string;
  retryable: boolean;
  raw?: unknown;
  /** True for prompt-too-long errors that context recovery can attempt to resolve. */
  recoverableViaCompact?: boolean;
  /** True for multimodal processor errors recoverable by stripping images from context. */
  recoverableViaImageStrip?: boolean;
};

export const PROMPT_TOO_LONG_ANTHROPIC_PATTERN = /prompt is too long/i;
export const PROMPT_TOO_LONG_OPENAI_PATTERN = /input length and max_tokens exceed context limit/i;
export const REQUEST_TOO_LARGE_PATTERN = /request too large/i;
export const MAX_OUTPUT_REACHED_PATTERN = /max(?:imum)? (?:output|completion) tokens? (?:exceeded|reached)/i;
export const MULTIMODAL_PROCESSOR_PATTERN = /failed to apply.*processor/i;

export class ModelConfigError extends Error {
  readonly name = "ModelConfigError";

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ModelRequestError extends Error {
  readonly name = "ModelRequestError";

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ModelProviderError extends Error {
  readonly name = "ModelProviderError";

  constructor(readonly error: CanonicalModelError) {
    super(error.message);
  }
}
