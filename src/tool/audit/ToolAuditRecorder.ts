import type { PermissionDecision, PermissionDecisionReason, PermissionMode } from "../../permission/index.js";
import type { PilotDeckToolErrorCode } from "../protocol/errors.js";

export type PilotDeckPermissionAuditRecord = {
  type: "permission";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
  decision: PermissionDecision["type"];
  reason: PermissionDecisionReason;
  createdAt: string;
};

export type PilotDeckToolAuditRecord = {
  type: "tool";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  errorCode?: PilotDeckToolErrorCode;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type PilotDeckToolAuditRecorder = {
  recordPermission(record: PilotDeckPermissionAuditRecord): void | Promise<void>;
  recordTool(record: PilotDeckToolAuditRecord): void | Promise<void>;
};
