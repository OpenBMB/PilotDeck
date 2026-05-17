export type AgentErrorCode =
  | "agent_aborted"
  | "agent_max_turns_reached"
  | "agent_model_error"
  | "agent_model_capability_error"
  | "agent_prompt_too_long"
  | "agent_context_recovery_failed"
  | "agent_tool_result_pairing_failed"
  | "agent_transcript_error"
  | "agent_invalid_state"
  | "agent_unsupported_feature"
  | "agent_tool_error_loop";

export type AgentError = {
  code: AgentErrorCode;
  message: string;
  details?: unknown;
};

export class AgentRuntimeError extends Error {
  readonly name = "AgentRuntimeError";

  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function agentError(code: AgentErrorCode, message: string, details?: unknown): AgentError {
  return { code, message, details };
}

export function normalizeAgentError(error: unknown): AgentError {
  if (error instanceof AgentRuntimeError) {
    return agentError(error.code, error.message, error.details);
  }

  if (error instanceof Error) {
    return agentError("agent_invalid_state", error.message);
  }

  return agentError("agent_invalid_state", String(error));
}
