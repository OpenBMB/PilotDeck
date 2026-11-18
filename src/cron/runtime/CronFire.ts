import type { Gateway, GatewayEvent } from "../../gateway/index.js";
import type { CronReminder, CronResultDeliveryHandler, CronRunError, CronRunRecord, CronRunOutcome, CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { computeNextRunAt, CRON_SCHEDULE_COMPUTATION_VERSION } from "./CronSchedule.js";
import { taskReminder } from "../storage/CronReminderStore.js";
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";

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
  onReminder?: (reminder: CronReminder) => Promise<void>;
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
    const sessionKey = snapshot.sessionKey;
    const active: CronActiveRun = {
      runId, taskId: snapshot.taskId, sessionKey,
      scheduleType: snapshot.schedule.type, stopRequested: false,
    };
    this.deps.registerActiveRun(active);
    let claimed = false;
    let notified = false;
    let executionStarted = false;
    let deferred = false;
    let task = snapshot;
    let output = "";
    let artifacts: CronRunRecord["artifacts"] = [];
    let outcome: CronRunOutcome = "completed";
    let error: CronRunRecord["error"];
    let finishReason: string | undefined;
    let workspaceCwd = task.workspaceCwd ?? task.projectKey;
    const record = (): CronRunRecord => ({
      schemaVersion: 1, runId, taskId: task.taskId, sessionKey, projectKey: task.projectKey,
      startedAt: startedAt.toISOString(), scheduledAt: trigger === "scheduled" ? snapshot.nextRunAt : startedAt.toISOString(),
      trigger, taskName: task.name ?? task.message.slice(0, 120), message: task.message, workspaceCwd,
    });
    const beginExecution = async (showInput = true) => {
      if (executionStarted) return;
      executionStarted = true;
      await this.deps.store.appendRun(record());
      this.phase(task, runId, "cron_started", startedAt.toISOString());
      try { if (showInput) this.deps.onTurnEvent?.(sessionKey, "cron", { type: "agent_status", event: "cron_input", runId,
        detail: { message: task.message, projectKey: task.projectKey, taskId: task.taskId, trigger, scheduledAt: snapshot.nextRunAt } }); }
      catch (caught) { this.warn("cron turn event delivery failed", caught, task.taskId, runId); }
    };
    try {
      if ((await this.deps.gateway.getActiveTurnSnapshot?.({ sessionKey, includeEvents: false }))?.active) return;
      const current = await this.deps.store.updateTask(snapshot.taskId, (value) => {
        if (value.status === "running" || (trigger === "scheduled" && (value.status !== "scheduled" || value.enabled === false))
          || (value.revision ?? 0) !== (snapshot.revision ?? 0)
          || value.nextRunAt !== snapshot.nextRunAt || value.lastRunId !== snapshot.lastRunId) return value;
        claimed = true;
        return { ...value, status: "running", lastRunId: runId, lastRun: record(),
          revision: (value.revision ?? 0) + 1, updatedAt: startedAt.toISOString() };
      });
      options.onClaim?.(claimed);
      notified = true;
      if (!claimed || !current) return;
      task = current;

      if (active.stopRequested) throw new Error("Cron run was stopped before execution.");
      workspaceCwd = await this.deps.prepareRun?.(task, runId, sessionKey) ?? workspaceCwd;
      if (workspaceCwd !== (task.workspaceCwd ?? task.projectKey)) {
        await this.deps.store.updateTask(task.taskId, current => current.lastRunId === runId
          ? { ...current, lastRun: record(), revision: (current.revision ?? 0) + 1 } : current);
      }
      // Preparation and workspace persistence can yield to a successful stop.
      // Keep this check adjacent to submission, with no intervening await.
      if (active.stopRequested) return;
      const mode = task.mode ?? "default";
      const canPrompt = mode === "default";
      const syntheticMessages = task.notificationPolicy === "findings" ? [{
        purpose: "scheduled_task_result_policy",
        text: "If there are no new findings or actions to report, reply with exactly [NO_UPDATE].",
      }] : [];
      for await (const event of this.deps.gateway.submitTurn({
        sessionKey, channelKey: "cron",
        projectKey: task.projectKey, workspaceCwd, message: task.message, mode,
        canPrompt, allowPlanModeTools: false, runId, timeoutMs: this.deps.runTimeoutMs,
        syntheticMessages,
        ...(task.modelSelection ? { modelOverride: { mode: "model", ...task.modelSelection } } : {}),
      })) {
        // A user can win admission between the status read and the task claim.
        // Keep the original occurrence pending; no execution or failure happened.
        if (!executionStarted && event.type === "agent_status" && event.event === "session_busy") continue;
        if (!executionStarted && event.type === "error" && ["session_busy", "replace_turn_pending"].includes(event.code ?? "")) {
          deferred = true;
          break;
        }
        await beginExecution();
        await this.deps.store.appendRunEvent(runId, event);
        const unavailableInteraction = !canPrompt && (event.type === "permission_request" || event.type === "elicitation_request");
        if (!unavailableInteraction) {
          try { this.deps.onTurnEvent?.(sessionKey, "cron", event); }
          catch (caught) { this.warn("cron turn event delivery failed", caught, task.taskId, runId); }
        }
        if (event.type === "assistant_text_delta") output += event.text;
        if (event.type === "file_artifacts") artifacts = [...artifacts, ...event.artifacts].slice(-100);
        if (event.type === "turn_completed") finishReason = event.finishReason;
        if (unavailableInteraction) {
          outcome = "blocked";
          error = event.type === "permission_request"
            ? { code: "cron_permission_required", message: `Authorization is required for ${event.toolName}.`, toolName: event.toolName }
            : { code: "cron_interaction_required", message: "This task needs your input." };
          void this.deps.gateway.abortTurn({ sessionKey, runId, reason: "system:interaction_required" }).catch(() => undefined);
        }
        if (event.type === "error" && outcome !== "blocked") {
          outcome = event.code === "agent_aborted" ? "aborted" : "failed";
          error = { code: event.code === "turn_timeout" ? "cron_run_timeout" : event.code ?? "cron_run_failed", message: event.message };
        }
      }
      if (outcome === "completed" && finishReason === "system_aborted") {
        outcome = "failed";
        error = { code: "cron_system_aborted", message: "The system interrupted this task." };
      }
    } catch (caught) {
      outcome = "failed";
      error = { code: "cron_run_failed", message: caught instanceof Error ? caught.message : String(caught) };
    } finally {
      try {
        if (claimed && deferred) {
          await this.deps.store.updateTask(task.taskId, current => current.lastRunId !== runId ? current : {
            ...current, status: current.enabled === false ? "paused" : snapshot.status,
            lastRunId: snapshot.lastRunId, lastRun: snapshot.lastRun,
            revision: (current.revision ?? 0) + 1, updatedAt: this.deps.now().toISOString(),
          });
        } else if (claimed) {
          const preparationFailed = !executionStarted && error && !active.stopRequested;
          await beginExecution(!preparationFailed);
          if (preparationFailed) {
            // No agent turn owns this failure. Record it through the shared
            // transcript status contract so reopening retains the same error.
            await this.deps.gateway.recordAgentStatusMessage?.({ sessionKey, projectKey: task.projectKey, turnId: runId,
              status: { event: "gateway_submit_failed", kind: "error", text: error!.message,
                detail: createVisibleErrorStatusDetail({ message: error!.message, code: error!.code,
                  userHint: "Review the task workspace and settings, then retry.", scope: "turn", source: "gateway" }) },
            }).catch(caught => this.warn("cron preparation error persistence failed", caught, task.taskId, runId));
            const event: GatewayEvent = { type: "error", runId, code: error!.code, message: error!.message, recoverable: true };
            await this.deps.store.appendRunEvent(runId, event);
            try { this.deps.onTurnEvent?.(sessionKey, "cron", event); }
            catch (caught) { this.warn("cron preparation error delivery failed", caught, task.taskId, runId); }
          }
          if (active.stopRequested) outcome = "stopped";
          if (outcome === "blocked" && error) await this.recordBlockedStatus(task, runId, error);
          const finishedAt = this.deps.now();
          let terminal: CronRunRecord = { ...record(), finishedAt: finishedAt.toISOString(), outcome,
            output: output.trim().slice(-100_000), artifacts, error, deliveryStatus: "pending" };
          // Persist execution before delivery; an unavailable channel must not erase a result.
          await this.deps.store.appendRun(terminal).catch((caught) => this.warn("cron run terminal record write failed", caught, task.taskId, runId));
          this.phase(task, runId, outcome === "completed" ? "cron_completed" : "cron_failed", finishedAt.toISOString(), error);
          terminal = await this.deliverResult(task, terminal);
          await this.deps.store.appendRun(terminal).catch((caught) => this.warn("cron delivery record write failed", caught, task.taskId, runId));
          await this.finishTask(task, snapshot, terminal, trigger).catch((caught) => this.warn("cron task post-run update failed", caught, task.taskId, runId));
          if (outcome !== "stopped" && outcome !== "aborted"
            && (outcome !== "completed" || task.notificationPolicy !== "failures")
            && !(outcome === "completed" && task.notificationPolicy === "findings" && output.trim() === "[NO_UPDATE]")) {
            await this.deps.onReminder?.(taskReminder(task, outcome === "completed" ? "completed" : "failed", finishedAt.toISOString(), terminal))
              .catch(caught => this.warn("cron reminder persistence failed", caught, task.taskId, runId));
          }
          await this.deps.releaseRun?.(task, sessionKey).catch((caught) => this.warn("cron session cleanup failed", caught, task.taskId, runId));
          // The stream has drained and Gateway admission is released. The Web
          // bridge can now dispatch ordinary queued replies in this same session.
          try { this.deps.onTurnEvent?.(sessionKey, "cron", { type: "agent_status", event: "cron_settled", runId,
            detail: { finishReason: outcome === "completed" ? "completed" : outcome === "stopped" || outcome === "aborted" ? "aborted" : "error" } }); }
          catch (caught) { this.warn("cron queue settlement delivery failed", caught, task.taskId, runId); }
        }
      } finally {
        if (!notified) options.onClaim?.(false);
        this.deps.unregisterActiveRun(runId);
        if (executionStarted) this.deps.onFinished?.();
      }
    }
  }

  async deliverResult(task: CronTask, run: CronRunRecord): Promise<CronRunRecord> {
    // Results belong to the task transcript. Never append them to a source chat.
    return { ...run, deliveryStatus: "skipped", deliveryError: undefined };
  }

  private async recordBlockedStatus(task: CronTask, runId: string, error: CronRunError): Promise<void> {
    const messageKey = error.code === "cron_interaction_required" ? "inputRequired"
      : error.code === "cron_permission_required" ? "required" : "denied";
    const hasTool = !!error.toolName || messageKey === "inputRequired";
    const status = {
      event: "cron_blocked",
      kind: "error" as const,
      text: error.message,
      detail: createVisibleErrorStatusDetail({
        message: error.message,
        messageI18n: {
          key: `alwaysOn:cron.authorization.${messageKey}${hasTool ? "" : "Generic"}`,
          params: error.toolName ? { tool: error.toolName } : undefined,
        },
        code: error.code,
        userHint: "Review the task's execution permissions before running it again.",
        userHintI18n: { key: "alwaysOn:cron.authorization.reviewPermissions" },
        scope: "turn",
        source: "gateway",
      }),
    };
    await this.deps.gateway.recordAgentStatusMessage?.({ sessionKey: task.sessionKey, projectKey: task.projectKey, turnId: runId, status })
      .catch(caught => this.warn("cron blocked status persistence failed", caught, task.taskId, runId));
    const event: GatewayEvent = { type: "agent_status", event: status.event, detail: status.detail, runId };
    await this.deps.store.appendRunEvent(runId, event)
      .catch(caught => this.warn("cron blocked event persistence failed", caught, task.taskId, runId));
    try { this.deps.onTurnEvent?.(task.sessionKey, "cron", event); }
    catch (caught) { this.warn("cron blocked status delivery failed", caught, task.taskId, runId); }
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
