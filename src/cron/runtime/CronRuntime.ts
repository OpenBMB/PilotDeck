import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
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
import { createCronCreateTool } from "../tool/CronCreateTool.js";
import { createCronDeleteTool } from "../tool/CronDeleteTool.js";
import { createCronListTool } from "../tool/CronListTool.js";
import { createCronStopTool } from "../tool/CronStopTool.js";
import { CronFire, type CronActiveRun } from "./CronFire.js";
import { computeNextRunAt } from "./CronSchedule.js";
import { CronScheduler } from "./CronScheduler.js";

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
  private readonly tools: PilotDeckToolDefinition[];
  private readonly activeRuns = new Map<string, CronActiveRun>();
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
    this.tools = [
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
    });
    this.scheduler = new CronScheduler({
      config: this.config,
      store: this.store,
      fire: this.fire,
      uuid: this.uuid,
      now: this.now,
      logger: this.logger,
      activeRunCount: () => this.activeRuns.size,
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
    await this.scheduler.start();
    this.logger.info("cron runtime started", { projectKey: this.projectKey });
  }

  async stop(): Promise<void> {
    await this.scheduler?.stop();
  }

  async createTask(input: CronCreateInput): Promise<CronCreateResult> {
    if (!this.config.enabled) {
      throw new Error("Cron is disabled. Enable it in pilotdeck.yaml to create tasks.");
    }
    const now = this.now();
    const taskId = this.uuid();
    const sessionKey = buildCronSessionKey(taskId);
    const schedule = normalizeSchedule(input);
    const nextRunAt = computeNextRunAt(schedule, now);
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
      timezone: input.timezone ?? (schedule.type === "cron" ? schedule.timezone : undefined) ?? this.config.timezone,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
    };
    await this.store.putTask(task);
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

    await this.createTask({
      message: task.message,
      schedule: { type: "once", runAt: new Date().toISOString() },
      projectKey: task.projectKey,
      mode: task.mode,
    });
    return { started: true, taskId: task.taskId };
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
}

export function createCronRuntime(options: CreateCronRuntimeOptions): CronRuntime {
  return new CronRuntime(options);
}

function normalizeSchedule(input: CronCreateInput): CronTask["schedule"] {
  if (input.schedule.type === "once") {
    return { type: "once", runAt: input.schedule.runAt };
  }
  return {
    type: "cron",
    expression: input.schedule.expression,
    timezone: input.schedule.timezone ?? input.timezone,
  };
}

function buildCronSessionKey(taskId: string): string {
  return `cron:${taskId}`;
}
