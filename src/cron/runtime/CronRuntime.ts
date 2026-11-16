import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  SessionConfigOverrides,
} from "../../always-on/runtime/SessionConfigOverrides.js";
import type { Gateway } from "../../gateway/index.js";
import type { PilotDeckToolDefinition } from "../../tool/index.js";
import type { CronConfig } from "../config/parseCronConfig.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronRunNowInput,
  CronRunNowResult,
  CronStopInput,
  CronStopResult,
  CronTask,
  CronTaskChange,
  CronResultDeliveryHandler,
  CronUpdateInput,
  CronUpdateResult,
} from "../protocol/types.js";
import { resolveCronPaths, type CronPaths } from "../storage/CronPaths.js";
import { CronTaskStore } from "../storage/CronTaskStore.js";
import { isValidCronTimezone, resolveCronTimezone } from "../CronTimezone.js";
import { CronFire, type CronActiveRun, type CronTurnEventHandler } from "./CronFire.js";
import { computeNextRunAt, CRON_SCHEDULE_COMPUTATION_VERSION } from "./CronSchedule.js";
import { CronScheduler } from "./CronScheduler.js";
import { prepareCronWorkspace } from "./CronWorkspace.js";
import { previewCronSchedule } from "./CronSchedule.js";
import { createCronTools } from "../tool/createCronTools.js";
import type { TelemetryClient } from "../../telemetry/index.js";

export type CronRuntimeLogger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

export type CreateCronRuntimeOptions = {
  config: CronConfig;
  pilotHome: string;
  projectKey: string;
  now?: () => Date;
  uuid?: () => string;
  logger?: CronRuntimeLogger;
  store?: CronTaskStore;
  telemetry?: TelemetryClient;
  sessionOverrides?: SessionConfigOverrides;
  activeRunCount?: () => number;
  skipToolCreation?: boolean;
  onResultDelivery?: CronResultDeliveryHandler;
  onTurnEvent?: CronTurnEventHandler;
  onTaskChange?: (change: CronTaskChange) => void;
  generateTaskTitle?: (task: CronTask, signal: AbortSignal) => Promise<string | null>;
  onRunFinished?: () => void;
};

const NOOP_LOGGER: CronRuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export class CronRuntime {
  readonly config: CronConfig;
  readonly projectKey: string;
  readonly paths: CronPaths;

  private readonly store: CronTaskStore;
  private readonly generateTaskTitle?: CreateCronRuntimeOptions["generateTaskTitle"];
  private readonly titleJobs = new Map<string, AbortController>();
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly logger: CronRuntimeLogger;
  private readonly telemetry?: TelemetryClient;
  private readonly onResultDelivery?: CronResultDeliveryHandler;
  private readonly onTurnEvent?: CronTurnEventHandler;
  private readonly sessionOverrides: SessionConfigOverrides;
  private readonly tools: PilotDeckToolDefinition[];
  private readonly activeRuns = new Map<string, CronActiveRun>();
  private readonly sharedActiveRunCount?: () => number;
  private readonly onRunFinished?: () => void;
  private readonly runningPromises = new Set<Promise<void>>();
  private gateway?: Gateway;
  private fire?: CronFire;
  private scheduler?: CronScheduler;

  constructor(options: CreateCronRuntimeOptions) {
    this.config = options.config;
    this.generateTaskTitle = options.generateTaskTitle;
    this.projectKey = resolve(options.projectKey);
    this.paths = resolveCronPaths({ pilotHome: options.pilotHome, projectKey: this.projectKey });
    this.store = options.store ?? new CronTaskStore(this.paths);
    if (options.onTaskChange) this.store.subscribe(options.onTaskChange);
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.telemetry = options.telemetry;
    this.onResultDelivery = options.onResultDelivery;
    this.onTurnEvent = options.onTurnEvent;
    this.sessionOverrides = options.sessionOverrides ?? new SessionConfigOverrides();
    this.sharedActiveRunCount = options.activeRunCount;
    this.onRunFinished = options.onRunFinished;
    this.tools = options.skipToolCreation ? [] : createCronTools(this);
  }

  getTools(): PilotDeckToolDefinition[] {
    if (!this.config.enabled) return [];
    return [...this.tools];
  }

  bindGateway(gateway: Gateway): void {
    if (this.gateway) {
      throw new Error("CronRuntime.bindGateway already called.");
    }
    this.gateway = gateway;
    this.fire = new CronFire({
      gateway,
      store: this.store,
      now: this.now,
      logger: this.logger,
      registerActiveRun: (run) => this.registerActiveRun(run),
      unregisterActiveRun: (runId) => this.unregisterActiveRun(runId),
      getActiveRun: (runId) => this.activeRuns.get(runId),
      runTimeoutMs: this.config.runTimeoutMinutes * 60_000,
      defaultTimezone: this.config.timezone,
      releaseTaskSession: (task) => this.releaseTaskSession(task),
      prepareRun: async (task, runId, sessionKey) => {
        const cwd = await prepareCronWorkspace(task, runId, resolve(this.paths.rootDir, "worktrees"));
        this.registerTaskSession({ ...task, sessionKey, workspaceCwd: cwd });
        return cwd;
      },
      onFinished: () => { this.scheduler?.poke(); this.onRunFinished?.(); },
      onResultDelivery: this.onResultDelivery,
      onTurnEvent: this.onTurnEvent,
      onPhaseEvent: (event) => {
        this.telemetry?.trackFeatureLoopStage({
          module: "cron_job",
          loopStage: "module_event",
          outcome: event.phase === "cron_failed" ? "failed" : "success",
          sessionId: event.runId,
          metadata: {
            phase: event.phase,
            runId: event.runId,
            taskId: event.taskId,
            title: event.title,
          },
        });
        if (event.error) {
          this.telemetry?.trackError(event.error.message, {
            module: "cron_job",
            loopStage: "loop_end",
            errorCategory: "loop_error",
            code: event.error.code,
            sessionId: event.runId,
            metadata: {
              taskId: event.taskId,
              phase: event.phase,
            },
          });
        }
      },
    });
    this.scheduler = new CronScheduler({
      config: this.config,
      store: this.store,
      fire: this.fire,
      uuid: this.uuid,
      now: this.now,
      logger: this.logger,
      activeRunCount: () => this.sharedActiveRunCount?.() ?? this.activeRuns.size,
    });
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info("cron disabled in config; runtime is a no-op.");
      return;
    }
    if (!this.scheduler) {
      throw new Error("CronRuntime.start called before bindGateway.");
    }
    await this.migrateLegacyTaskSessions();
    await this.recoverInterruptedRuns();
    await this.prepareTaskSessions();
    await this.scheduler.start();
    for (const task of await this.store.listTasks()) {
      if (task.lastRun?.deliveryStatus === "pending" && task.lastRun.finishedAt && this.fire) {
        const run = await this.fire.deliverResult(task, task.lastRun);
        await this.store.appendRun(run);
        await this.store.updateTask(task.taskId, current => ({ ...current, lastRun: run }));
      }
    }
    this.logger.info("cron runtime started", { projectKey: this.projectKey });
  }

  async stop(): Promise<void> {
    for (const controller of this.titleJobs.values()) controller.abort();
    this.titleJobs.clear();
    await this.scheduler?.stop();
    if (this.gateway) {
      const activeRuns = [...this.activeRuns.values()];
      for (const active of activeRuns) {
        active.stopRequested = true;
      }
      await Promise.all(
        activeRuns.map((active) =>
          this.gateway!
            .abortTurn({ sessionKey: active.sessionKey, runId: active.runId, reason: "system:cron_shutdown" })
            .catch(() => undefined),
        ),
      );
    }
    await Promise.allSettled([...this.runningPromises]);
    await this.fire?.drain();
    const tasks = await this.store.listTasks();
    await Promise.all(tasks.filter((task) => task.executionMode !== "conversation").map((task) => this.releaseTaskSession(task)));
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  async createTask(input: CronCreateInput): Promise<CronCreateResult> {
    if (!this.config.enabled) {
      throw new Error("Cron is disabled. Enable it in pilotdeck.yaml to create tasks.");
    }
    validateTaskOptions(input);
    if (!input.message?.trim()) throw new Error("Cron task message is required.");
    const now = this.now();
    const taskId = this.uuid();
    const executionMode = "persistent";
    const sessionKey = buildCronSessionKey(taskId);
    const schedule = normalizeSchedule(input, this.config.timezone, now);
    const timezone = scheduleTimezone(schedule, input.timezone ?? this.config.timezone);
    const nextRunAt = computeNextRunAt(schedule, now, timezone);
    if (!nextRunAt) {
      throw new Error("Cron schedule does not produce a valid future run time.");
    }
    if (schedule.type === "once" && nextRunAt.getTime() < now.getTime()) {
      throw new Error("One-time Cron tasks must be scheduled in the future.");
    }
    const task: CronTask = {
      schemaVersion: 1,
      taskId,
      name: taskName(input.name, input.message),
      message: input.message.trim(),
      enabled: true,
      executionMode,
      workspaceCwd: input.workspaceCwd ? resolve(input.workspaceCwd) : this.projectKey,
      notificationPolicy: input.notificationPolicy ?? "all",
      workspaceMode: input.workspaceMode ?? "local",
      modelSelection: input.modelSelection,
      schedule,
      status: "scheduled",
      sessionKey,
      channelKey: "cron",
      originSessionKey: input.sessionKey,
      originProjectKey: input.originProjectKey ?? input.projectKey ?? this.projectKey,
      originChannelKey: input.channelKey,
      // Session-scoped callers should pass the originating project explicitly.
      // Keep the runtime root only as a compatibility fallback for direct callers.
      projectKey: input.projectKey ?? this.projectKey,
      mode: input.mode ?? "default",
      timezone,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      revision: 0,
      scheduleComputationVersion: schedule.type === "cron" ? CRON_SCHEDULE_COMPUTATION_VERSION : undefined,
    };
    if (executionMode === "persistent") this.registerTaskSession(task);
    try {
      await this.store.putTask(task);
    } catch (error) {
      await this.releaseTaskSession(task);
      throw error;
    }
    this.telemetry?.trackFeatureLoopStage({
      module: "cron_job",
      loopStage: "module_event",
      outcome: "success",
      sessionId: sessionKey,
      metadata: {
        phase: "task_created",
        taskId,
        scheduleType: schedule.type,
      },
    });
    this.scheduler?.poke();
    if (!input.name) this.scheduleTitle(task);
    return { task, nextRuns: previewCronSchedule(schedule, now, timezone) };
  }

  private scheduleTitle(task: CronTask): void {
    if (!this.generateTaskTitle) return;
    this.titleJobs.get(task.taskId)?.abort();
    const controller = new AbortController();
    this.titleJobs.set(task.taskId, controller);
    // Naming is independent of admission and must never delay scheduled work.
    void (async () => {
      try {
        const title = (await this.generateTaskTitle!(task, controller.signal))?.replace(/\s+/g, " ").trim().slice(0, 120);
        if (!title || controller.signal.aborted) return;
        await this.store.updateTask(task.taskId, current => {
          if (controller.signal.aborted || current.message !== task.message || current.name !== task.name) return current;
          // A derived title is metadata: do not invalidate an open schedule edit.
          return { ...current, name: title, updatedAt: this.now().toISOString() };
        });
      } catch (error) {
        if (!controller.signal.aborted) this.logger.warn("cron task title generation failed", { taskId: task.taskId });
      } finally {
        if (this.titleJobs.get(task.taskId) === controller) this.titleJobs.delete(task.taskId);
      }
    })();
  }

  async listTasks(input: CronListInput = {}): Promise<CronListResult> {
    const tasks = (await this.store.listTasks()).filter((task) => !input.taskId || task.taskId === input.taskId);
    const result: CronListResult = { tasks };
    if (input.includeHistory) {
      const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)));
      const runs = await this.store.listRuns(limit + 1, input.taskId, input.beforeRunId);
      result.recentRuns = runs.slice(0, limit);
      if (runs.length > limit) result.nextBeforeRunId = runs[limit - 1].runId;
    }
    return result;
  }

  async prepareConversation(taskId: string): Promise<{ task: CronTask; workspaceCwd: string }> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error("Scheduled task is unavailable.");
    const workspaceCwd = await prepareCronWorkspace(task, taskId, resolve(this.paths.rootDir, "worktrees"));
    this.registerTaskSession({ ...task, workspaceCwd });
    return { task, workspaceCwd };
  }

  async updateTask(input: CronUpdateInput): Promise<CronUpdateResult> {
    if (!this.config.enabled) throw new Error("Cron is disabled. Enable it in pilotdeck.yaml to update tasks.");
    if (typeof input.projectKey !== "string" || !input.projectKey.trim() || !this.matchesProject(input.projectKey)) return { updated: false, reason: "not_found" };
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Cron task expectedRevision must be a non-negative integer.");
    if (!input.message?.trim()) throw new Error("Cron task message is required.");
    validateTaskOptions(input);
    const now = this.now();
    const schedule = normalizeSchedule(input, this.config.timezone, now);
    const timezone = scheduleTimezone(schedule, input.timezone ?? this.config.timezone);
    let messageChanged = false;
    let reason: Extract<CronUpdateResult, { updated: false }>["reason"] | undefined;
    const updated = await this.store.updateTask(input.taskId, (current) => {
      if (resolve(current.projectKey ?? this.projectKey) !== resolve(input.projectKey)) { reason = "not_found"; return current; }
      if ((current.revision ?? 0) !== input.expectedRevision) { reason = "conflict"; return current; }
      const scheduleChanged = JSON.stringify(current.schedule) !== JSON.stringify(schedule) || current.timezone !== timezone;
      const changedConfiguration = scheduleChanged
        || ["notificationPolicy", "mode", "workspaceMode", "modelSelection"].some((key) =>
          input[key as keyof CronUpdateInput] !== undefined
          && JSON.stringify(input[key as keyof CronUpdateInput]) !== JSON.stringify(current[key as keyof CronTask]));
      if (current.status === "running" && changedConfiguration) { reason = "running"; return current; }
      const enabled = input.enabled ?? (scheduleChanged && ["completed", "failed", "missed"].includes(current.status) ? true : current.enabled ?? true);
      const rearming = enabled && current.enabled === false;
      let nextRunAt = current.nextRunAt;
      if (scheduleChanged || rearming) {
        nextRunAt = computeNextRunAt(schedule, now, timezone)?.toISOString();
        if (!nextRunAt || (schedule.type === "once" && Date.parse(nextRunAt) <= now.getTime())) {
          throw new Error("Cron schedule must have a future run time before it can be resumed.");
        }
      }
      messageChanged = current.message !== input.message.trim();
      const executionMode = "persistent";
      const workspaceMode = input.workspaceMode ?? current.workspaceMode;
      return { ...current, name: taskName(input.name ?? current.name, input.message), message: input.message.trim(),
        schedule, timezone, nextRunAt, enabled,
        executionMode, targetSessionKey: undefined, sessionKey: current.sessionKey.startsWith('cron:') ? current.sessionKey : buildCronSessionKey(current.taskId),
        notificationPolicy: input.notificationPolicy ?? current.notificationPolicy,
        mode: input.mode ?? current.mode, workspaceMode, modelSelection: input.modelSelection === null ? undefined : input.modelSelection ?? current.modelSelection,
        status: current.status === "running" ? "running" : !enabled
          ? input.enabled === false ? "paused" : current.status : "scheduled",
        statusDetail: undefined, updatedAt: now.toISOString(), revision: (current.revision ?? 0) + 1,
        scheduleComputationVersion: schedule.type === "cron" ? CRON_SCHEDULE_COMPUTATION_VERSION : undefined };
    });
    if (!updated) return { updated: false, reason: "not_found" };
    if (reason) return { updated: false, reason };
    this.scheduler?.poke();
    if (input.name !== undefined) this.titleJobs.get(updated.taskId)?.abort();
    else if (messageChanged) this.scheduleTitle(updated);
    return { updated: true, task: updated };
  }

  async deleteTask(input: CronDeleteInput): Promise<CronDeleteResult> {
    let stoppedRunId: string | undefined;
    if (input.stopRunning) {
      const stopped = await this.stopTask({ taskId: input.taskId });
      stoppedRunId = stopped.runId;
    }
    const deleted = await this.store.deleteTask(input.taskId);
    if (deleted) {
      this.titleJobs.get(input.taskId)?.abort();
      this.titleJobs.delete(input.taskId);
      await this.releaseTaskSessionById(input.taskId);
    }
    this.scheduler?.poke();
    return { deleted, stoppedRunId };
  }

  async stopTask(input: CronStopInput): Promise<CronStopResult> {
    const active = this.findActiveRun(input);
    if (!active || !this.gateway) {
      return { stopped: false, taskId: input.taskId, runId: input.runId };
    }
    active.stopRequested = true;
    await this.gateway.abortTurn({ sessionKey: active.sessionKey, runId: active.runId });
    const deletedOneTimeTask = false;
    this.scheduler?.poke();
    return {
      stopped: true,
      taskId: active.taskId,
      runId: active.runId,
      deletedOneTimeTask,
    };
  }

  async runTaskNow(input: CronRunNowInput): Promise<CronRunNowResult> {
    if (!this.config.enabled) return { started: false, reason: "disabled" };
    const task = await this.store.getTask(input.taskId);
    if (!task) return { started: false, reason: "not_found" };
    if (!this.fire) throw new Error("Cron runtime has no bound gateway.");
    if (input.retryDeliveryRunId) {
      const run = (await this.store.listRuns(100, task.taskId)).find((entry) => entry.runId === input.retryDeliveryRunId);
      if (!run?.finishedAt) throw new Error("Cron delivery record was not found.");
      const result = await this.fire.deliverResult(task, run);
      await this.store.appendRun(result);
      await this.store.updateTask(task.taskId, (current) => current.lastRunId === run.runId ? { ...current, lastRun: result } : current);
      return { started: result.deliveryStatus === "sent" || result.deliveryStatus === "skipped", taskId: task.taskId, runId: run.runId };
    }
    if (task.status === "running" || [...this.activeRuns.values()].some((run) => run.taskId === task.taskId)) return { started: false, reason: "already_running", taskId: task.taskId };
    if ((await this.gateway?.getActiveTurnSnapshot?.({ sessionKey: task.sessionKey, includeEvents: false }))?.active) return { started: false, reason: "already_running", taskId: task.taskId };
    if ((this.sharedActiveRunCount?.() ?? this.activeRuns.size) >= this.config.maxConcurrentRuns) return { started: false, reason: "concurrency_limit", taskId: task.taskId };
    const runId = this.uuid();
    let resolveClaim!: (value: boolean) => void;
    const claimed = new Promise<boolean>((resolve) => { resolveClaim = resolve; });
    const pending = this.fire.runTask(task, runId, { trigger: "manual", onClaim: resolveClaim });
    this.runningPromises.add(pending);
    void pending.catch((error) => this.logger.warn("cron manual run failed", { error: String(error) }))
      .finally(() => this.runningPromises.delete(pending));
    const started = await claimed;
    return { started, reason: started ? undefined : "already_running", taskId: task.taskId, runId: started ? runId : undefined };
  }

  poke(): void { this.scheduler?.poke(); }

  runTickOnce(): Promise<void> {
    if (!this.scheduler) {
      throw new Error("CronRuntime.runTickOnce called before bindGateway.");
    }
    return this.scheduler.runTickOnce();
  }

  private registerActiveRun(run: CronActiveRun): void {
    this.activeRuns.set(run.runId, run);
  }

  private unregisterActiveRun(runId: string): CronActiveRun | undefined {
    const run = this.activeRuns.get(runId);
    this.activeRuns.delete(runId);
    return run;
  }

  private findActiveRun(input: CronStopInput): CronActiveRun | undefined {
    for (const run of this.activeRuns.values()) {
      if (input.runId && run.runId !== input.runId) {
        continue;
      }
      if (input.taskId && run.taskId !== input.taskId) {
        continue;
      }
      if (!input.runId && !input.taskId) {
        continue;
      }
      return run;
    }
    return undefined;
  }

  private matchesProject(projectKey: string): boolean {
    return resolve(projectKey) === this.projectKey;
  }

  private async migrateLegacyTaskSessions(): Promise<void> {
    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      // Reuse the latest owned transcript from the previous per-run model.
      // A user's ordinary conversation is never adopted or modified.
      const previousRun = task.executionMode === "independent" ? (await this.store.listRuns(1, task.taskId))[0] : undefined;
      const sessionKey = task.executionMode === "persistent" && task.sessionKey.startsWith("cron:")
        ? task.sessionKey : previousRun?.sessionKey.startsWith("cron:") ? previousRun.sessionKey : buildCronSessionKey(task.taskId);
      if (task.executionMode === "persistent" && task.sessionKey === sessionKey && task.channelKey === "cron" && !task.targetSessionKey) continue;
      if (task.sessionKey.startsWith("cron:")) {
        this.sessionOverrides.delete(task.sessionKey);
        await this.gateway?.closeSession({ sessionKey: task.sessionKey, reason: "cron/task-context-migrated" }).catch(() => undefined);
      }
      await this.store.putTask({ ...task, executionMode: "persistent", targetSessionKey: undefined,
        sessionKey, channelKey: "cron", revision: (task.revision ?? 0) + 1, updatedAt: this.now().toISOString() });
    }
  }

  private registerTaskSession(task: CronTask): void {
    this.sessionOverrides.set(task.sessionKey, {
      cwd: task.workspaceCwd,
      permissionMode: task.mode ?? "default",
      // Interactive turns use the ordinary chat capabilities. CronFire applies
      // canPrompt=false and hides interactive tools on unattended turns only.
    });
  }

  private async prepareTaskSessions(): Promise<void> {
    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      if (task.executionMode === "conversation") continue;
      this.registerTaskSession(task);
      await this.gateway
        ?.closeSession({ sessionKey: task.sessionKey, reason: "cron/unattended-policy-refresh" })
        .catch(() => undefined);
    }
  }

  private async releaseTaskSession(task: CronTask): Promise<void> {
    if (task.executionMode === "conversation") return;
    this.sessionOverrides.delete(task.sessionKey);
    await this.gateway
      ?.closeSession({ sessionKey: task.sessionKey, reason: "cron/task-finished" })
      .catch(() => undefined);
  }

  private async releaseTaskSessionById(taskId: string): Promise<void> {
    const sessionKey = buildCronSessionKey(taskId);
    this.sessionOverrides.delete(sessionKey);
    await this.gateway
      ?.closeSession({ sessionKey, reason: "cron/task-removed" })
      .catch(() => undefined);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const now = this.now();
    const tasks = await this.store.listTasks();
    const savedRuns = new Map((await this.store.listRuns(Number.MAX_SAFE_INTEGER)).map(run => [run.runId, run]));
    let recoveredCount = 0;

    for (const task of tasks) {
      if (task.status !== "running") {
        if (task.status === "scheduled" && task.enabled !== false && task.schedule.type === "once"
          && task.nextRunAt && Date.parse(task.nextRunAt) < now.getTime() - 60_000) {
          await this.store.putTask({ ...task, status: "missed", enabled: false, nextRunAt: undefined,
            statusDetail: "This one-time task was missed while the server was offline. Run it manually or choose a new time.",
            revision: (task.revision ?? 0) + 1, updatedAt: now.toISOString() });
        }
        continue;
      }
      recoveredCount += 1;
      let lastRun = task.lastRunId ? savedRuns.get(task.lastRunId) : undefined;
      if (task.lastRunId && !lastRun?.finishedAt) {
        const startedAt = Number.isNaN(new Date(task.updatedAt).getTime())
          ? now.toISOString()
          : task.updatedAt;
        lastRun = {
          schemaVersion: 1,
          runId: task.lastRunId,
          taskId: task.taskId,
          sessionKey: task.executionMode === "independent" ? `cron:${task.taskId}:${task.lastRunId}` : task.sessionKey,
          projectKey: task.projectKey, message: task.message, taskName: task.name, scheduledAt: task.nextRunAt,
          trigger: lastRun?.trigger ?? "scheduled", output: lastRun?.output,
          startedAt,
          finishedAt: now.toISOString(),
          outcome: "failed",
          error: {
            code: "cron_run_interrupted",
            message: "Cron run was interrupted before the runtime restarted.",
          },
        };
        await this.store.appendRun(lastRun);
      }

      if (task.schedule.type === "once") {
        await this.store.putTask({ ...task, status: lastRun?.outcome === "completed" ? "completed" : "failed", enabled: false, nextRunAt: undefined,
          lastRun, statusDetail: lastRun?.error?.message,
          revision: (task.revision ?? 0) + 1, updatedAt: now.toISOString() });
        continue;
      }

      const timezone = resolveCronTimezone(
        "timezone" in task.schedule ? task.schedule.timezone : undefined,
        task.timezone,
        this.config.timezone,
      );
      const schedule = task.schedule.type === "cron" ? { ...task.schedule, timezone } : task.schedule;
      await this.store.putTask({
        ...task,
        schedule,
        timezone,
        lastRun,
        status: task.enabled === false ? "paused" : "scheduled",
        nextRunAt: computeNextRunAt(schedule, now, timezone)?.toISOString(),
        revision: (task.revision ?? 0) + 1,
        scheduleComputationVersion: CRON_SCHEDULE_COMPUTATION_VERSION,
        updatedAt: now.toISOString(),
      });
    }

    if (recoveredCount > 0) {
      this.logger.warn("cron runtime recovered interrupted runs", { recoveredCount });
    }
  }
}

export function createCronRuntime(options: CreateCronRuntimeOptions): CronRuntime {
  return new CronRuntime(options);
}

type CronScheduleInput = Pick<CronCreateInput, "schedule" | "timezone">
  | Pick<CronUpdateInput, "schedule" | "timezone">;

export function normalizeSchedule(input: CronScheduleInput, configTimezone: string, now: Date): CronTask["schedule"] {
  if (input.timezone !== undefined && !isValidCronTimezone(input.timezone)) throw new Error(`Invalid Cron timezone: ${input.timezone}`);
  if (!input.schedule || typeof input.schedule !== "object") throw new Error("Cron schedule is required.");
  const schedule = input.schedule;
  if (schedule.type === "once") {
    if (typeof schedule.runAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(schedule.runAt)
      || !Number.isFinite(Date.parse(schedule.runAt))) throw new Error("Invalid Cron absolute time: include an explicit timezone offset.");
    return { type: "once", runAt: new Date(schedule.runAt).toISOString() };
  }
  if (schedule.type === "delay") {
    const runAt = computeNextRunAt(schedule, now);
    if (!runAt || !Number.isFinite(runAt.getTime())) throw new Error("Cron delay schedule must use a positive finite amount.");
    return { type: "once", runAt: runAt.toISOString() };
  }
  if (schedule.type === "interval") {
    const normalized = { ...schedule, anchorAt: schedule.anchorAt ?? now.toISOString() };
    if (!computeNextRunAt(normalized, now)) throw new Error("Cron interval must be an integer of at least 60 seconds.");
    return normalized;
  }
  if (schedule.type === "monthly") {
    const normalized = { ...schedule, timezone: schedule.timezone ?? input.timezone ?? configTimezone };
    if (!computeNextRunAt(normalized, now)) throw new Error("Invalid Cron monthly weekday rule.");
    return normalized;
  }
  if (schedule.type !== "cron" || typeof schedule.expression !== "string") throw new Error("Invalid Cron schedule type.");
  const timezone = resolveCronTimezone(schedule.timezone, input.timezone, configTimezone);
  if (schedule.timezone && !isValidCronTimezone(schedule.timezone)) throw new Error(`Invalid Cron timezone: ${schedule.timezone}`);
  if (!computeNextRunAt({ ...schedule, timezone }, now)) throw new Error("Invalid Cron expression or no future occurrence.");
  return { type: "cron", expression: schedule.expression.trim().replace(/\s+/g, " "), timezone };
}

function scheduleTimezone(schedule: CronTask["schedule"], fallback: string): string {
  return "timezone" in schedule ? schedule.timezone ?? fallback : fallback;
}
function taskName(name: string | undefined, message: string): string {
  const result = (name ?? message.trim().split(/\r?\n/, 1)[0]).trim();
  if (!result || result.length > 120) {
    if (name !== undefined) throw new Error("Cron task name must contain 1 to 120 characters.");
    return result.slice(0, 120);
  }
  return result;
}
function validateTaskOptions(input: Partial<CronCreateInput> | Partial<CronUpdateInput>): void {
  if (input.executionMode !== undefined && !["independent", "conversation", "persistent"].includes(input.executionMode)) throw new Error("Invalid Cron execution mode.");
  if (input.mode !== undefined && !["default", "plan", "bypassPermissions"].includes(input.mode)) throw new Error("Invalid Cron permission mode.");
  if (input.notificationPolicy !== undefined && !["all", "findings", "failures"].includes(input.notificationPolicy)) throw new Error("Invalid Cron notification policy.");
  if (input.workspaceMode !== undefined && !["local", "worktree"].includes(input.workspaceMode)) throw new Error("Invalid Cron workspace mode.");
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 120)) throw new Error("Cron task name must contain 1 to 120 characters.");
  if (input.modelSelection && (!input.modelSelection.provider?.trim() || !input.modelSelection.model?.trim())) throw new Error("Invalid Cron model selection.");
}
function buildCronSessionKey(taskId: string): string { return `cron:${taskId}`; }
