import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { CronResultDeliveryHandler, CronRunRecord, CronRunOutcome, CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { computeNextRunAt, CRON_SCHEDULE_COMPUTATION_VERSION } from "./CronSchedule.js";

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
  prepareRun?: (task: CronTask, runId: string, sessionKey: string) => Promise<string | undefined>;
  releaseRun?: (task: CronTask, sessionKey: string) => Promise<void>;
  onFinished?: () => void;
};

export type CronFireOptions = {
  trigger?: "scheduled" | "manual";
  onClaim?: (claimed: boolean) => void;
};

export class CronFire {
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly deps: CronFireDependencies) {}

  runTask(snapshot: CronTask, runId: string, options: CronFireOptions = {}): Promise<void> {
    const execution = this.executeTask(snapshot, runId, options);
    this.pending.add(execution);
    void execution.finally(() => this.pending.delete(execution)).catch(() => undefined);
    return execution;
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.pending]); }

  private async executeTask(snapshot: CronTask, runId: string, options: CronFireOptions): Promise<void> {
    const trigger = options.trigger ?? "scheduled";
    const startedAt = this.deps.now();
    const sessionKey = snapshot.executionMode === "independent"
      ? `cron:${snapshot.taskId}:${runId}` : snapshot.sessionKey;
    const active: CronActiveRun = {
      runId, taskId: snapshot.taskId, sessionKey,
      scheduleType: snapshot.schedule.type, stopRequested: false,
    };
    this.deps.registerActiveRun(active);
    let claimed = false;
    let notified = false;
    let task = snapshot;
    let output = "";
    let artifacts: CronRunRecord["artifacts"] = [];
    let outcome: CronRunOutcome = "completed";
    let error: CronRunRecord["error"];
    let workspaceCwd = task.workspaceCwd ?? task.projectKey;
    const record = (): CronRunRecord => ({
      schemaVersion: 1, runId, taskId: task.taskId, sessionKey, projectKey: task.projectKey,
      startedAt: startedAt.toISOString(), scheduledAt: trigger === "scheduled" ? snapshot.nextRunAt : startedAt.toISOString(),
      trigger, taskName: task.name ?? task.message.slice(0, 120), message: task.message, workspaceCwd,
    });
    try {
      const current = await this.deps.store.updateTask(snapshot.taskId, (value) => {
        if (value.status === "running" || (trigger === "scheduled" && (value.status !== "scheduled" || value.enabled === false))
          || (value.revision ?? 0) !== (snapshot.revision ?? 0)
          || value.nextRunAt !== snapshot.nextRunAt || value.lastRunId !== snapshot.lastRunId) return value;
        claimed = true;
        return { ...value, status: "running", lastRunId: runId,
          revision: (value.revision ?? 0) + 1, updatedAt: startedAt.toISOString() };
      });
      options.onClaim?.(claimed);
      notified = true;
      if (!claimed || !current) return;
      task = current;
      await this.deps.store.appendRun(record());
      this.phase(task, runId, "cron_started", startedAt.toISOString());

      // A follow-up waits for the original conversation instead of interrupting its user turn.
      while (task.executionMode === "conversation"
        && (await this.deps.gateway.getActiveTurnSnapshot?.({ sessionKey, includeEvents: false }))?.active) {
        if (active.stopRequested) throw new Error("Cron run was stopped while waiting for its conversation.");
        if (this.deps.now().getTime() - startedAt.getTime() >= this.deps.runTimeoutMs) throw new Error("Cron conversation wait timed out.");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (active.stopRequested) throw new Error("Cron run was stopped before execution.");
      workspaceCwd = await this.deps.prepareRun?.(task, runId, sessionKey) ?? workspaceCwd;
      const message = task.notificationPolicy === "findings"
        ? `${task.message}\n\nIf there are no new findings or actions to report, reply with exactly [NO_UPDATE].` : task.message;
      for await (const event of this.deps.gateway.submitTurn({
        sessionKey, channelKey: task.executionMode === "conversation" ? task.originChannelKey ?? task.channelKey : "cron",
        projectKey: task.projectKey, workspaceCwd, message, mode: task.mode ?? "default",
        canPrompt: false, allowPlanModeTools: false, runId, timeoutMs: this.deps.runTimeoutMs,
        ...(task.modelSelection ? { modelOverride: { mode: "model", ...task.modelSelection } } : {}),
      })) {
        await this.deps.store.appendRunEvent(runId, event);
        try { this.deps.onTurnEvent?.(sessionKey, task.channelKey, event); }
        catch (caught) { this.warn("cron turn event delivery failed", caught, task.taskId, runId); }
        if (event.type === "assistant_text_delta") output += event.text;
        if (event.type === "file_artifacts") artifacts = [...artifacts, ...event.artifacts].slice(-100);
        if (event.type === "tool_call_finished" && !event.ok && /permission[_ ](?:required|denied)|cannot prompt/i.test(event.resultPreview ?? "")) {
          outcome = "blocked";
          error = { code: "cron_permission_required", message: "This task needs additional permission. Review its permission setting and retry." };
        }
        if (event.type === "permission_request" || event.type === "elicitation_request") {
          outcome = "blocked";
          error = { code: "cron_interaction_required", message: "This task needs input or permission. Update its settings and retry." };
          void this.deps.gateway.abortTurn({ sessionKey, runId, reason: "system:interaction_required" }).catch(() => undefined);
        }
        if (event.type === "error" && outcome !== "blocked") {
          outcome = event.code === "agent_aborted" ? "aborted" : "failed";
          error = { code: event.code === "turn_timeout" ? "cron_run_timeout" : event.code ?? "cron_run_failed", message: event.message };
        }
      }
    } catch (caught) {
      outcome = "failed";
      error = { code: "cron_run_failed", message: caught instanceof Error ? caught.message : String(caught) };
    } finally {
      if (!notified) options.onClaim?.(false);
      if (claimed) {
        if (active.stopRequested) outcome = "stopped";
        const finishedAt = this.deps.now();
        let terminal: CronRunRecord = { ...record(), finishedAt: finishedAt.toISOString(), outcome,
          output: output.trim().slice(-100_000), artifacts, error, deliveryStatus: "pending" };
        // Persist execution before delivery; an unavailable channel must not erase a result.
        await this.deps.store.appendRun(terminal).catch((caught) => this.warn("cron run terminal record write failed", caught, task.taskId, runId));
        this.phase(task, runId, outcome === "completed" ? "cron_completed" : "cron_failed", finishedAt.toISOString(), error);
        terminal = await this.deliverResult(task, terminal);
        await this.deps.store.appendRun(terminal).catch((caught) => this.warn("cron delivery record write failed", caught, task.taskId, runId));
        await this.finishTask(task, snapshot, terminal, trigger).catch((caught) => this.warn("cron task post-run update failed", caught, task.taskId, runId));
        await this.deps.releaseRun?.(task, sessionKey).catch((caught) => this.warn("cron session cleanup failed", caught, task.taskId, runId));
      }
      this.deps.unregisterActiveRun(runId);
      this.deps.onFinished?.();
    }
  }

  async deliverResult(task: CronTask, run: CronRunRecord): Promise<CronRunRecord> {
    if (!this.deps.onResultDelivery || !task.originSessionKey
      || task.executionMode === "conversation"
      || (task.notificationPolicy === "failures" && run.outcome === "completed")
      || (task.notificationPolicy === "findings" && run.output?.trim() === "[NO_UPDATE]")) {
      return { ...run, deliveryStatus: "skipped", deliveryError: undefined };
    }
    const text = run.outcome === "completed" ? run.output || "The scheduled task completed without a text result."
      : run.error?.message || "The scheduled task did not complete.";
    let deliveryError: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const delivered = await this.deps.onResultDelivery({
          taskId: task.taskId, taskName: task.name, runId: run.runId, sessionKey: run.sessionKey, channelKey: task.channelKey,
          originSessionKey: task.originSessionKey, originChannelKey: task.originChannelKey,
          originProjectKey: task.originProjectKey,
          projectKey: task.projectKey, outcome: run.outcome ?? "failed", text, error: run.error,
        });
        if (delivered === false) throw new Error("The result channel is unavailable.");
        return { ...run, deliveryStatus: "sent", deliveryError: undefined };
      } catch (caught) {
        deliveryError = caught instanceof Error ? caught.message : String(caught);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 250));
      }
    }
    return { ...run, deliveryStatus: "failed", deliveryError };
  }

  private async finishTask(task: CronTask, snapshot: CronTask, run: CronRunRecord, trigger: "scheduled" | "manual"): Promise<void> {
    await this.deps.store.updateTask(task.taskId, (current) => {
      if (current.lastRunId !== run.runId) return current;
      const enabled = current.enabled !== false;
      let nextRunAt = snapshot.nextRunAt;
      let status: CronTask["status"] = enabled ? "scheduled" : "paused";
      if (trigger === "scheduled") {
        nextRunAt = current.schedule.type === "once" ? undefined
          : computeNextRunAt(current.schedule, new Date(run.finishedAt!), current.timezone ?? this.deps.defaultTimezone)?.toISOString();
        if (current.schedule.type === "once" || !nextRunAt) status = run.outcome === "completed" ? "completed" : "failed";
      } else if (["completed", "failed", "missed"].includes(snapshot.status)) {
        status = run.outcome === "completed" ? "completed" : "failed";
      }
      if (run.outcome === "blocked") status = "failed";
      return { ...current, status, enabled: status === "scheduled",
        nextRunAt, lastRun: run, statusDetail: run.error?.message,
        revision: (current.revision ?? 0) + 1, updatedAt: run.finishedAt! };
    });
  }

  private phase(task: CronTask, runId: string, phase: "cron_started" | "cron_completed" | "cron_failed", timestamp: string, error?: CronRunRecord["error"]): void {
    try {
      this.deps.onPhaseEvent?.({ phase, runId, taskId: task.taskId, projectKey: task.projectKey, timestamp, title: task.name ?? task.message.slice(0, 120), error });
    } catch (caught) { this.warn("cron phase notification failed", caught, task.taskId, runId); }
  }

  private warn(message: string, error: unknown, taskId: string, runId: string): void {
    this.deps.logger?.warn(message, { taskId, runId, error: error instanceof Error ? error.message : String(error) });
  }
}
