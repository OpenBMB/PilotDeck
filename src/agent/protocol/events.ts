import type { CanonicalMessage, CanonicalModelEvent, CanonicalToolCall } from "../../model/index.js";
import type { PilotDeckToolResult } from "../../tool/index.js";
import type { AgentError } from "./errors.js";
import type { AgentTurnResult } from "./result.js";
import type { AgentLoopTransition } from "./state.js";
import type { TokenBudgetSnapshot } from "../../context/budget/TokenBudgetManager.js";

export type AgentEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "session_ended"; sessionId: string; reason: string }
  | { type: "turn_started"; sessionId: string; turnId: string }
  | { type: "input_accepted"; sessionId: string; turnId: string; messages: CanonicalMessage[] }
  | { type: "user_prompt_submitted"; sessionId: string; turnId: string; prompt: string }
  | { type: "setup_completed"; sessionId: string }
  | { type: "model_request_started"; sessionId: string; turnId: string; model: string; provider: string }
  | { type: "model_event"; sessionId: string; turnId: string; event: CanonicalModelEvent }
  | { type: "instructions_loaded"; sessionId: string; turnId: string; hasSystemPrompt: boolean }
  | { type: "assistant_message"; sessionId: string; turnId: string; message: CanonicalMessage }
  | { type: "tool_calls_detected"; sessionId: string; turnId: string; calls: CanonicalToolCall[] }
  | { type: "pre_tool_execute"; sessionId: string; turnId: string; toolCallId: string; toolName: string }
  | { type: "post_tool_execute"; sessionId: string; turnId: string; toolCallId: string; toolName: string; success: boolean }
  | { type: "permission_requested"; sessionId: string; turnId: string; toolCallId: string; toolName: string }
  | { type: "permission_denied"; sessionId: string; turnId: string; toolName: string; reason: string }
  | { type: "tool_result"; sessionId: string; turnId: string; result: PilotDeckToolResult }
  | { type: "tool_results_projected"; sessionId: string; turnId: string; message: CanonicalMessage }
  | { type: "mode_change_requested"; sessionId: string; turnId: string; mode: string }
  | { type: "stop_requested"; sessionId: string; turnId: string }
  | { type: "stop_failure"; sessionId: string; turnId: string; error: string }
  | { type: "compact_started"; sessionId: string; turnId: string; trigger: string; preTokens: number }
  | { type: "compact_completed"; sessionId: string; turnId: string; status: string; preTokens: number; postTokens?: number }
  | { type: "context_budget"; sessionId: string; turnId: string; snapshot: TokenBudgetSnapshot }
  | { type: "subagent_started"; sessionId: string; turnId: string; subagentId: string; subagentType: string }
  | { type: "subagent_completed"; sessionId: string; turnId: string; subagentId: string; subagentType: string; success: boolean; durationMs: number }
  | {
      type: "subagent_status";
      sessionId: string;
      turnId: string;
      subagentId: string;
      subagentType?: string;
      status: "running" | "waiting_model" | "tool_started" | "tool_completed";
      toolCallId?: string;
      toolName?: string;
      success?: boolean;
      durationMs?: number;
    }
  | { type: "subagent_model_event"; sessionId: string; turnId: string; subagentId: string; subagentType: string; event: CanonicalModelEvent }
  | { type: "subagent_tool_calls_detected"; sessionId: string; turnId: string; subagentId: string; subagentType: string; calls: CanonicalToolCall[] }
  | { type: "subagent_tool_result"; sessionId: string; turnId: string; subagentId: string; subagentType: string; result: PilotDeckToolResult }
  | { type: "elicitation_requested"; sessionId: string; turnId: string; requestId: string; toolName: string }
  | { type: "elicitation_resolved"; sessionId: string; requestId: string; delivered: boolean }
  | { type: "turn_continued"; sessionId: string; turnId: string; reason: AgentLoopTransition["reason"] }
  | { type: "turn_completed"; sessionId: string; turnId: string; result: AgentTurnResult }
  | { type: "turn_failed"; sessionId: string; turnId: string; error: AgentError }
  | { type: "session_aborted"; sessionId: string; reason?: string };

export type AgentEventEmitter = (event: AgentEvent) => void;

export type AgentEventBufferHandle = {
  emitter: AgentEventEmitter;
  drain: () => AgentEvent[];
};

export function createAgentEventBuffer(): AgentEventBufferHandle {
  const buffer: AgentEvent[] = [];
  return {
    emitter: (event) => buffer.push(event),
    drain: () => buffer.splice(0),
  };
}
