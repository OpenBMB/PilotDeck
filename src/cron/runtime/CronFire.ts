import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { CronResultDeliveryHandler, CronRunRecord, CronRunOutcome, CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { resolveCronTimezone } from "../CronTimezone.js";
import { computeNextRunAt } from "./CronSchedule.js";

export type CronActiveRun = {
  runId: string;
  taskId: string;
  sessionKey: string;
  scheduleType: CronTask["schedule"]["type"];
  stopRequested: boolean;
};

export type CronPhaseEventCallback = (event: {
  phase: "cron_started" | "cron_completed" | "cron_failed";
  runId: string;
  taskId: string;
  projectKey?: string;
  timestamp: string;
  title?: string;
  error?: { code: string; message: string };
}) => void;

export type CronTurnEventHandler = (sessionKey: string, channelKey: string, event: GatewayEvent) => void;

export type CronFireDependencies = {
  gateway: Gateway;
  store: CronTaskStore;
  now: () => Date;
  registerActiveRun: (run: CronActiveRun) => void;
  unregisterActiveRun: (runId: string) => CronActiveRun | undefined;
  getActiveRun: (runId: string) => CronActiveRun | undefined;
  runTimeoutMs: number;
  defaultTimezone: string;
  releaseTaskSession: (task: CronTask) => Promise<void>;
  onResultDelivery?: CronResultDeliveryHandler;
  onTurnEvent?: CronTurnEventHandler;
  logger?: {
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
  onPhaseEvent?: CronPhaseEventCallback;
};

export class CronFire {
  constructor(private readonly deps: CronFireDependencies) {}

  async runTask(taskSnapshot: CronTask, runId: string): Promise<void> {
    const startedAt = this.deps.now();
    const activeRun: CronActiveRun = {
      runId,
      taskId: taskSnapshot.taskId,
      sessionKey: taskSnapshot.sessionKey,
      scheduleType: taskSnapshot.schedule.type,
      stopRequested: false,
    };
    this.deps.registerActiveRun(activeRun);

    let task = taskSnapshot;
    let outcome: CronRunOutcome = "completed";
    let error: CronRunRecord["error"];
    let forcedFailure = false;
    let abortRequested = false;
    let startedRun = false;
    let assistantText = "";
    try {
      let claimed = false;
      const currentTask = await this.deps.store.updateTask(taskSnapshot.taskId, (current) => {
        if (!matchesScheduledSnapshot(current, taskSnapshot)) {
          return current;
        }
        claimed = true;
        return {
          ...current,
          status: "running",
          lastRunId: runId,
          revision: (current.revision ?? 0) + 1,
          updatedAt: startedAt.toISOString(),
        };
      });
      if (!claimed || !currentTask) {
        outcome = "aborted";
        return;
      }
      task = currentTask;
      startedRun = true;
      this.deps.onPhaseEvent?.({
        phase: "cron_started",
        runId,
        taskId: task.taskId,
        projectKey: task.projectKey,
        timestamp: startedAt.toISOString(),
        title: task.message.trimStart().split(/\r?\n/, 1)[0]?.trim().slice(0, 120),
      });
      for await (const event of this.deps.gateway.submitTurn({
        sessionKey: task.sessionKey,
        channelKey: task.channelKey,
        projectKey: task.projectKey,
        message: task.message,
        mode: "bypassPermissions",
        runId,
        timeoutMs: this.deps.runTimeoutMs,
      })) {
        await this.deps.store.appendRunEvent(runId, event);
        this.forwardTurnEvent(task, event);
        if (event.type === "assistant_text_delta") {
          assistantText += event.text;
        }
        if (event.type === "elicitation_request" || event.type === "permission_request") {
          outcome = "failed";
          forcedFailure = true;
          error = {
            code: "cron_interaction_required",
            message: `Cron run requested unsupported user interaction through ${event.type}.`,
          };
          if (!abortRequested) {
            abortRequested = true;
            void this.deps.gateway
              .abortTurn({ sessionKey: task.sessionKey, runId, reason: "system:interaction_required" })
              .catch(() => undefined);
          }
          continue;
        }
        if (event.type === "error") {
          if (event.code === "turn_timeout") {
            outcome = "failed";
            forcedFailure = true;
            error = {
              code: "cron_run_timeout",
              message: event.message,
            };
            continue;
          }
          if (forcedFailure) {
            continue;
          }
          outcome = event.code === "agent_aborted" ? "aborted" : "failed";
          error = { code: event.code ?? "cron_run_failed", message: event.message };
        }
      }
    } catch (caught) {
      if (!forcedFailure) {
        outcome = "failed";
        error = {
          code: "cron_run_failed",
          message: caught instanceof Error ? caught.message : String(caught),
        };
      }
    } finally {
      const currentActive = this.deps.getActiveRun(runId);
      if (currentActive?.stopRequested) {
        outcome = "stopped";
      }
      this.deps.unregisterActiveRun(runId);
      if (!startedRun) {
        return;
      }
      const finishedAt = this.deps.now();
      await this.deps.store
        .appendRun({
          schemaVersion: 1,
          runId,
          taskId: task.taskId,
          sessionKey: task.sessionKey,
          projectKey: task.projectKey,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          outcome,
          error,
        })
        .catch((persistError: unknown) => {
          this.deps.logger?.warn("cron run terminal record write failed", {
            taskId: task.taskId,
            runId,
            error: persistError instanceof Error ? persistError.message : String(persistError),
          });
        });
      this.deps.onPhaseEvent?.({
        phase: outcome === "completed" ? "cron_completed" : "cron_failed",
        runId,
        taskId: task.taskId,
        projectKey: task.projectKey,
        timestamp: finishedAt.toISOString(),
        title: task.message.trimStart().split(/\r?\n/, 1)[0]?.trim().slice(0, 120),
        error,
      });
      await this.deliverResult(task, runId, outcome, assistantText, error).catch((deliveryError: unknown) => {
        this.deps.logger?.warn("cron result delivery failed", {
          taskId: task.taskId,
          runId,
          error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
        });
      });
      await this.updateTaskAfterRun(task, runId, finishedAt, outcome).catch((updateError: unknown) => {
        this.deps.logger?.warn("cron task post-run update failed", {
          taskId: task.taskId,
          runId,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });
      });
    }
  }

  private forwardTurnEvent(task: CronTask, event: GatewayEvent): void {
    try {
      this.deps.onTurnEvent?.(task.sessionKey, task.channelKey, event);
    } catch (error) {
      this.deps.logger?.warn("cron turn event delivery failed", {
        taskId: task.taskId,
        runId: task.lastRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async deliverResult(
    task: CronTask,
    runId: string,
    outcome: CronRunOutcome,
    assistantText: string,
    error: CronRunRecord["error"],
  ): Promise<void> {
    const text = outcome === "completed"
      ? assistantText.trim()
      : error?.message?.trim() || "Cron task failed.";
    const deliveryText = text || "定时任务已完成，但没有返回内容。";
    await this.deps.onResultDelivery?.({
      taskId: task.taskId,
      runId,
      sessionKey: task.sessionKey,
      channelKey: task.channelKey,
      originSessionKey: task.originSessionKey,
      originChannelKey: task.originChannelKey,
      projectKey: task.projectKey,
      outcome,
      text: deliveryText,
      error,
    });
  }

  private async updateTaskAfterRun(task: CronTask, runId: string, finishedAt: Date, outcome: CronRunOutcome): Promise<void> {
    if (task.schedule.type === "once") {
      let deleted = false;
      await this.deps.store.updateTask(task.taskId, (current) => {
        if (!matchesRunningTask(current, task, runId)) {
          return current;
        }
        deleted = true;
        return undefined;
      });
      if (deleted) {
        await this.deps.releaseTaskSession(task);
      }
      return;
    }
    const timezone = resolveCronTimezone(
      task.schedule.timezone,
      task.timezone,
      this.deps.defaultTimezone,
    );
    const schedule = { ...task.schedule, timezone };
    const nextRunAt = computeNextRunAt(schedule, finishedAt, timezone)?.toISOString();
    await this.deps.store.updateTask(task.taskId, (current) => {
      if (!matchesRunningTask(current, task, runId)) {
        return current;
      }
      return {
        ...current,
        schedule,
        timezone,
        status: "scheduled",
        nextRunAt,
        revision: (current.revision ?? 0) + 1,
        scheduleComputationVersion: 2,
        updatedAt: finishedAt.toISOString(),
      };
    });
    void outcome;
  }
}

function matchesScheduledSnapshot(current: CronTask, snapshot: CronTask): boolean {
  return current.status === "scheduled"
    && (current.revision ?? 0) === (snapshot.revision ?? 0)
    && current.nextRunAt === snapshot.nextRunAt
    && current.lastRunId === snapshot.lastRunId;
}

function matchesRunningTask(current: CronTask, claimedTask: CronTask, runId: string): boolean {
  return current.status === "running"
    && current.lastRunId === runId
    && (current.revision ?? 0) === (claimedTask.revision ?? 0);
}
