import type { GatewayChannelKey, GatewayMode } from "../../gateway/index.js";

export type CronTaskSchedule =
  | {
      type: "once";
      runAt: string;
    }
  | {
      type: "cron";
      expression: string;
      timezone?: string;
    };

export type CronCreateSchedule =
  | CronTaskSchedule
  | {
      type: "delay";
      amount: number;
      unit: "second" | "minute" | "hour" | "day";
    };

export type CronSchedule = CronCreateSchedule;

export type CronTaskStatus = "scheduled" | "running";

export type CronTask = {
  schemaVersion: 1;
  taskId: string;
  message: string;
  schedule: CronTaskSchedule;
  status: CronTaskStatus;
  sessionKey: string;
  channelKey: GatewayChannelKey;
  projectKey?: string;
  mode?: GatewayMode;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunId?: string;
  revision?: number;
  scheduleComputationVersion?: 2;
  originSessionKey?: string;
  originChannelKey?: GatewayChannelKey;
};

export type CronResultDelivery = {
  taskId: string;
  runId: string;
  sessionKey: string;
  channelKey: GatewayChannelKey;
  originSessionKey?: string;
  originChannelKey?: GatewayChannelKey;
  projectKey?: string;
  outcome: CronRunOutcome;
  text: string;
  error?: {
    code: string;
    message: string;
  };
};

export type CronResultDeliveryHandler = (delivery: CronResultDelivery) => Promise<void> | void;

export type CronRunOutcome = "completed" | "failed" | "aborted" | "stopped";

export type CronRunRecord = {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  sessionKey: string;
  projectKey?: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: CronRunOutcome;
  error?: {
    code: string;
    message: string;
  };
};

export type CronCreateInput = {
  message: string;
  schedule: CronCreateSchedule;
  sessionKey?: string;
  channelKey?: GatewayChannelKey;
  projectKey?: string;
  mode?: GatewayMode;
  timezone?: string;
};

export type CronCreateResult = {
  task: CronTask;
};

export type CronUpdateInput = {
  taskId: string;
  projectKey: string;
  expectedRevision: number;
  message: string;
  schedule: CronTaskSchedule;
  timezone?: string;
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
  includeHistory?: boolean;
  limit?: number;
};

export type CronListResult = {
  tasks: CronTask[];
  recentRuns?: CronRunRecord[];
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
};

export type CronRunNowResult = {
  started: boolean;
  reason?: "not_found" | "already_running";
  taskId?: string;
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
  if (outcome === "failed" || outcome === "aborted" || outcome === "stopped") return "failed";
  return "completed";
}
