import type { GatewayChannelKey } from "../../gateway/index.js";

import type { CronTaskSchedule, CronCreateSchedule } from "./schedules.js";
export type { CronTaskSchedule, CronCreateSchedule, CronSchedule } from "./schedules.js";

export type CronTaskStatus = "scheduled" | "running" | "paused" | "completed" | "failed" | "missed";
export type CronExecutionMode = "independent" | "conversation" | "persistent";
/** Legacy mode names remain readable; every task now owns one persistent session. */
export type CronTaskChange = { taskId: string; projectKey?: string; task?: CronTask };
export type CronNotificationPolicy = "all" | "findings" | "failures";
export type CronPermissionMode = "default" | "bypassPermissions";
export type CronReminder = {
  id: string;
  taskId: string;
  projectKey: string;
  sessionKey: string;
  title: string;
  body: string;
  kind: "due" | "completed" | "failed";
  createdAt: string;
  occurrenceAt: string;
  runId?: string;
};
export type CronReminderListInput = { scope: string };
export type CronReminderDismissInput = { scope: string; id: string };

export type CronTask = {
  schemaVersion: 1;
  taskId: string;
  name?: string;
  message: string;
  schedule: CronTaskSchedule;
  status: CronTaskStatus;
  sessionKey: string;
  channelKey: GatewayChannelKey;
  projectKey?: string;
  workspaceCwd?: string;
  targetSessionKey?: string;
  executionMode?: CronExecutionMode;
  enabled?: boolean;
  notificationPolicy?: CronNotificationPolicy;
  workspaceMode?: "local" | "worktree";
  modelSelection?: { provider: string; model: string };
  statusDetail?: string;
  lastRun?: CronRunRecord;
  mode?: CronPermissionMode;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunId?: string;
  revision?: number;
  scheduleComputationVersion?: 2 | 3;
  originSessionKey?: string;
  originProjectKey?: string;
  originChannelKey?: GatewayChannelKey;
};

export type CronResultDelivery = {
  taskId: string;
  taskName?: string;
  runId: string;
  sessionKey: string;
  channelKey: GatewayChannelKey;
  originSessionKey?: string;
  originProjectKey?: string;
  originChannelKey?: GatewayChannelKey;
  projectKey?: string;
  outcome: CronRunOutcome;
  text: string;
  error?: {
    code: string;
    message: string;
  };
};

export type CronResultDeliveryHandler = (delivery: CronResultDelivery) => Promise<void | boolean> | void | boolean;

export type CronRunOutcome = "completed" | "failed" | "aborted" | "stopped" | "blocked";

export type CronRunError = {
  code: string;
  message: string;
  toolName?: string;
};

export type CronRunRecord = {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  sessionKey: string;
  projectKey?: string;
  startedAt: string;
  scheduledAt?: string;
  trigger?: "scheduled" | "manual";
  taskName?: string;
  message?: string;
  output?: string;
  artifacts?: Array<{ id: string; name: string; path: string; size: number; mimeType?: string }>;
  workspaceCwd?: string;
  deliveryStatus?: "pending" | "sent" | "failed" | "skipped";
  deliveryError?: string;
  finishedAt?: string;
  outcome?: CronRunOutcome;
  error?: CronRunError;
};

export type CronCreateInput = {
  name?: string;
  message: string;
  /** Prepare user-authored instructions before saving. Agent and API instructions are accepted as supplied by default. */
  generateInstructions?: boolean;
  schedule: CronCreateSchedule;
  sessionKey?: string;
  targetSessionKey?: string;
  originProjectKey?: string;
  channelKey?: GatewayChannelKey;
  projectKey?: string;
  workspaceCwd?: string;
  executionMode?: CronExecutionMode;
  notificationPolicy?: CronNotificationPolicy;
  workspaceMode?: "local" | "worktree";
  modelSelection?: { provider: string; model: string };
  mode?: CronPermissionMode;
  timezone?: string;
};

export type CronCreateResult = {
  task: CronTask;
  nextRuns?: string[];
};

export type CronUpdateInput = {
  taskId: string;
  projectKey: string;
  expectedRevision: number;
  message: string;
  schedule: CronTaskSchedule;
  timezone?: string;
  name?: string;
  enabled?: boolean;
  executionMode?: CronExecutionMode;
  targetSessionKey?: string;
  notificationPolicy?: CronNotificationPolicy;
  mode?: CronPermissionMode;
  workspaceMode?: "local" | "worktree";
  modelSelection?: { provider: string; model: string } | null;
};

export type CronUpdateResult =
  | {
      updated: true;
      task: CronTask;
    }
  | {
      updated: false;
      reason: "not_found" | "running" | "conflict";
    };

export type CronListInput = {
  projectKey?: string;
  taskId?: string;
  beforeRunId?: string;
  includeHistory?: boolean;
  limit?: number;
};

export type CronListResult = {
  tasks: CronTask[];
  recentRuns?: CronRunRecord[];
  nextBeforeRunId?: string;
};

export type CronDeleteInput = {
  taskId: string;
  projectKey?: string;
  stopRunning?: boolean;
};

export type CronDeleteResult = {
  deleted: boolean;
  stoppedRunId?: string;
};

export type CronStopInput = {
  taskId?: string;
  runId?: string;
  projectKey?: string;
};

export type CronStopResult = {
  stopped: boolean;
  taskId?: string;
  runId?: string;
  deletedOneTimeTask?: boolean;
};

export type CronRunNowInput = {
  taskId: string;
  projectKey?: string;
  retryDeliveryRunId?: string;
};

export type CronRunNowResult = {
  started: boolean;
  reason?: "not_found" | "already_running" | "concurrency_limit" | "disabled";
  taskId?: string;
  runId?: string;
};

export type CronRunOutcomeStatus = "completed" | "failed" | "running";

/**
 * Map a gateway `CronRunOutcome` (+ finishedAt presence) to a
 * UI-facing status. Centralised here so all clients share the same
 * mapping instead of reimplementing it.
 */
export function mapCronRunOutcome(
  outcome: CronRunOutcome | undefined | null,
  finishedAt: string | undefined | null,
): CronRunOutcomeStatus {
  if (!outcome) return finishedAt ? "completed" : "running";
  if (outcome === "completed") return "completed";
  if (outcome === "failed" || outcome === "aborted" || outcome === "stopped" || outcome === "blocked") return "failed";
  return "completed";
}
