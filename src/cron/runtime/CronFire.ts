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
  logger?: {
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
  onPhaseEvent?: CronPhaseEventCallback;
};

export class CronFire {
  constructor(private readonly deps: CronFireDependencies) {}

  async runTask(task: CronTask, runId: string): Promise<void> {
    const startedAt = this.deps.now();
    const activeRun: CronActiveRun = {
      runId,
      taskId: task.taskId,
      sessionKey: task.sessionKey,
      scheduleType: task.schedule.type,
      stopRequested: false,
    };
    this.deps.registerActiveRun(activeRun);

    let outcome: CronRunOutcome = "completed";
    let error: CronRunRecord["error"];
    let forcedFailure = false;
    let abortRequested = false;
    let startedRun = false;
    let assistantText = "";
    try {
      const started = await this.deps.store.replaceTask({
        ...task,
        status: "running",
        lastRunId: runId,
        updatedAt: startedAt.toISOString(),
      });
      if (!started) {
        outcome = "aborted";
        return;
      }
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
      await this.updateTaskAfterRun(task, finishedAt, outcome).catch((updateError: unknown) => {
        this.deps.logger?.warn("cron task post-run update failed", {
          taskId: task.taskId,
          runId,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });
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

  private async updateTaskAfterRun(task: CronTask, finishedAt: Date, outcome: CronRunOutcome): Promise<void> {
    if (task.schedule.type === "once") {
      try {
        await this.deps.store.deleteTask(task.taskId);
      } finally {
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
    await this.deps.store.updateTask(task.taskId, (current) => ({
      ...current,
      schedule,
      timezone,
      status: "scheduled",
      nextRunAt,
      scheduleComputationVersion: 2,
      updatedAt: finishedAt.toISOString(),
    }));
    void outcome;
  }
}
