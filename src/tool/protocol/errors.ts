export type PilotDeckToolErrorCode =
  | "tool_not_found"
  | "invalid_tool_input"
  | "permission_denied"
  | "permission_cancelled"
  | "permission_required"
  | "tool_execution_failed"
  | "tool_aborted"
  | "tool_timeout"
  | "result_too_large"
  | "path_not_allowed"
  | "file_not_found"
  | "file_conflict"
  | "unsupported_tool";

export type PilotDeckToolError = {
  code: PilotDeckToolErrorCode;
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
};

export class PilotDeckToolRuntimeError extends Error {
  readonly code: PilotDeckToolErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PilotDeckToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PilotDeckToolRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export function toolError(
  code: PilotDeckToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): PilotDeckToolError {
  return { code, message, details };
}

export function normalizeToolError(error: unknown): PilotDeckToolError {
  if (error instanceof PilotDeckToolRuntimeError) {
    return toolError(error.code, error.message, error.details);
  }

  if (error instanceof Error) {
    return {
      code: "tool_execution_failed",
      message: error.message,
      cause: error,
    };
  }

  return {
    code: "tool_execution_failed",
    message: "Tool execution failed with a non-Error value.",
    cause: error,
  };
}
