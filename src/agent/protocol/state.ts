import type { CanonicalMessage, CanonicalToolCall, CanonicalUsage } from "../../model/index.js";
import type { AgentPermissionDenial } from "./result.js";

export type AgentLoopTransitionReason =
  | "next_turn"
  | "model_error"
  | "max_turns"
  | "aborted_streaming"
  | "aborted_tools"
  | "auto_compact";

export type AgentLoopTransition = {
  reason: AgentLoopTransitionReason;
};

export type AgentSessionState = {
  sessionId: string;
  messages: CanonicalMessage[];
  usage: CanonicalUsage;
  permissionDenials: AgentPermissionDenial[];
  status: "idle" | "running" | "aborted" | "failed";
  currentTurnId?: string;
  abortController: AbortController;
};

export type AgentLoopState = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  turnCount: number;
  maxTurns?: number;
  pendingToolCalls: CanonicalToolCall[];
  lastAssistantMessage?: CanonicalMessage;
  usage: CanonicalUsage;
  transition?: AgentLoopTransition;
};
