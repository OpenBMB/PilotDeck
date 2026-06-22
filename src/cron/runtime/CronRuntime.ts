import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  SessionConfigOverrides,
  UNATTENDED_SESSION_EXCLUDED_TOOLS,
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
} from "../protocol/types.js";
import { resolveCronPaths, type CronPaths } from "../storage/CronPaths.js";
import { CronTaskStore } from "../storage/CronTaskStore.js";
import { isValidCronTimezone, resolveCronTimezone } from "../CronTimezone.js";
import { createCronCreateTool } from "../tool/CronCreateTool.js";
import { createCronDeleteTool } from "../tool/CronDeleteTool.js";
import { createCronListTool } from "../tool/CronListTool.js";
import { createCronStopTool } from "../tool/CronStopTool.js";
import { CronFire, type CronActiveRun } from "./CronFire.js";
import { computeNextRunAt } from "./CronSchedule.js";
import { CronScheduler } from "./CronScheduler.js";
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
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly logger: CronRuntimeLogger;
  private readonly telemetry?: TelemetryClient;
  private readonly sessionOverrides: SessionConfigOverrides;
  private readonly tools: PilotDeckToolDefinition[];
  private readonly activeRuns = new Map<string, CronActiveRun>();
  private readonly sharedActiveRunCount?: () => number;
  private gateway?: Gateway;
  private fire?: CronFire;
  private scheduler?: CronScheduler;

  constructor(options: CreateCronRuntimeOptions) {
    this.config = options.config;
    this.projectKey = resolve(options.projectKey);
    this.paths = resolveCronPaths({ pilotHome: options.pilotHome, projectKey: this.projectKey });
    this.store = options.store ?? new CronTaskStore(this.paths);
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.telemetry = options.telemetry;
    this.sessionOverrides = options.sessionOverrides ?? new SessionConfigOverrides();
    this.sharedActiveRunCount = options.activeRunCount;
    this.tools = options.skipToolCreation
      ? []
      : [
          createCronCreateTool(this),
          createCronListTool(this),
          createCronDeleteTool(this),
          createCronStopTool(this),
        ];
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
    this.logger.info("cron runtime started", { projectKey: this.projectKey });
  }

  async stop(): Promise<void> {
    await this.scheduler?.stop();
    if (this.gateway) {
      const activeRuns = [...this.activeRuns.values()];
      for (const active of activeRuns) {
        active.stopRequested = true;
      }
      await Promise.all(
        activeRuns.map((active) =>
          this.gateway!
            .abortTurn({ sessionKey: active.sessionKey, runId: active.runId })
            .catch(() => undefined),
        ),
      );
    }
    const tasks = await this.store.listTasks();
    await Promise.all(tasks.map((task) => this.releaseTaskSession(task)));
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  async createTask(input: CronCreateInput): Promise<CronCreateResult> {
    if (!this.config.enabled) {
      throw new Error("Cron is disabled. Enable it in pilotdeck.yaml to create tasks.");
    }
    const now = this.now();
    const taskId = this.uuid();
    const sessionKey = buildCronSessionKey(taskId);
    const schedule = normalizeSchedule(input, this.config.timezone);
    const timezone = schedule.type === "cron"
      ? schedule.timezone
      : input.timezone ?? this.config.timezone;
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
      message: input.message,
      schedule,
      status: "scheduled",
      sessionKey,
      channelKey: "cron",
      // Session-scoped callers should pass the originating project explicitly.
      // Keep the runtime root only as a compatibility fallback for direct callers.
      projectKey: input.projectKey ?? this.projectKey,
      mode: input.mode,
      timezone,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      scheduleComputationVersion: schedule.type === "cron" ? 2 : undefined,
    };
    this.registerTaskSession(task);
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
    return { task };
  }

  async listTasks(input: CronListInput = {}): Promise<CronListResult> {
    const tasks = await this.store.listTasks();
    const result: CronListResult = { tasks };
    if (input.includeHistory) {
      result.recentRuns = await this.store.listRuns(input.limit ?? 50);
    }
    return result;
  }

  async deleteTask(input: CronDeleteInput): Promise<CronDeleteResult> {
    let stoppedRunId: string | undefined;
    if (input.stopRunning) {
      const stopped = await this.stopTask({ taskId: input.taskId });
      stoppedRunId = stopped.runId;
    }
    const deleted = await this.store.deleteTask(input.taskId);
    if (deleted) {
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
    let deletedOneTimeTask = false;
    if (active.scheduleType === "once") {
      deletedOneTimeTask = await this.store.deleteTask(active.taskId);
      await this.releaseTaskSessionById(active.taskId);
    }
    this.scheduler?.poke();
    return {
      stopped: true,
      taskId: active.taskId,
      runId: active.runId,
      deletedOneTimeTask,
    };
  }

  async runTaskNow(input: CronRunNowInput): Promise<CronRunNowResult> {
    const tasks = await this.store.listTasks();
    const task = tasks.find((t) => t.taskId === input.taskId);
    if (!task) return { started: false, reason: "not_found" };
    if (task.status === "running") return { started: false, reason: "already_running", taskId: task.taskId };

    const created = await this.createTask({
      message: task.message,
      schedule: { type: "once", runAt: new Date().toISOString() },
      projectKey: task.projectKey,
      mode: task.mode,
    });
    return { started: true, taskId: created.task.taskId };
  }

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

  private async migrateLegacyTaskSessions(): Promise<void> {
    const tasks = await this.store.listTasks();
    let migratedCount = 0;
    for (const task of tasks) {
      const nextSessionKey = buildCronSessionKey(task.taskId);
      if (task.sessionKey === nextSessionKey && task.channelKey === "cron") {
        continue;
      }
      migratedCount += 1;
      this.sessionOverrides.delete(task.sessionKey);
      await this.gateway
        ?.closeSession({ sessionKey: task.sessionKey, reason: "cron/legacy-session-migrated" })
        .catch(() => undefined);
      await this.store.putTask({
        ...task,
        sessionKey: nextSessionKey,
        channelKey: "cron",
        updatedAt: this.now().toISOString(),
      });
    }
    if (migratedCount > 0) {
      this.logger.info("cron runtime migrated legacy task sessions", { migratedCount });
    }
  }

  private registerTaskSession(task: CronTask): void {
    this.sessionOverrides.set(task.sessionKey, {
      permissionMode: "bypassPermissions",
      bypassAvailable: true,
      canPrompt: false,
      excludeTools: [...UNATTENDED_SESSION_EXCLUDED_TOOLS],
    });
  }

  private async prepareTaskSessions(): Promise<void> {
    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      this.registerTaskSession(task);
      await this.gateway
        ?.closeSession({ sessionKey: task.sessionKey, reason: "cron/unattended-policy-refresh" })
        .catch(() => undefined);
    }
  }

  private async releaseTaskSession(task: CronTask): Promise<void> {
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
    const terminalRunIds = new Set(
      (await this.store.listRuns(Number.MAX_SAFE_INTEGER))
        .filter((run) => run.finishedAt && run.outcome)
        .map((run) => run.runId),
    );
    let recoveredCount = 0;

    for (const task of tasks) {
      if (task.status !== "running") continue;
      recoveredCount += 1;
      if (task.lastRunId && !terminalRunIds.has(task.lastRunId)) {
        const startedAt = Number.isNaN(new Date(task.updatedAt).getTime())
          ? now.toISOString()
          : task.updatedAt;
        await this.store.appendRun({
          schemaVersion: 1,
          runId: task.lastRunId,
          taskId: task.taskId,
          sessionKey: task.sessionKey,
          projectKey: task.projectKey,
          startedAt,
          finishedAt: now.toISOString(),
          outcome: "failed",
          error: {
            code: "cron_run_interrupted",
            message: "Cron run was interrupted before the runtime restarted.",
          },
        });
      }

      if (task.schedule.type === "once") {
        await this.store.deleteTask(task.taskId);
        await this.releaseTaskSession(task);
        continue;
      }

      const timezone = resolveCronTimezone(
        task.schedule.timezone,
        task.timezone,
        this.config.timezone,
      );
      const schedule = { ...task.schedule, timezone };
      await this.store.putTask({
        ...task,
        schedule,
        timezone,
        status: "scheduled",
        nextRunAt: computeNextRunAt(schedule, now, timezone)?.toISOString(),
        scheduleComputationVersion: 2,
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

function normalizeSchedule(input: CronCreateInput, configTimezone: string): CronTask["schedule"] {
  if (input.schedule.type === "once") {
    return { type: "once", runAt: input.schedule.runAt };
  }
  const requestedTimezone = input.schedule.timezone ?? input.timezone;
  if (requestedTimezone && !isValidCronTimezone(requestedTimezone)) {
    throw new Error(`Invalid Cron timezone: ${requestedTimezone}`);
  }
  const timezone = resolveCronTimezone(
    requestedTimezone,
    undefined,
    configTimezone,
  );
  return {
    type: "cron",
    expression: input.schedule.expression,
    timezone,
  };
}

function buildCronSessionKey(taskId: string): string {
  return `cron:${taskId}`;
}
