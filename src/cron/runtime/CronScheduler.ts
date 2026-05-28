import type { CronConfig } from "../config/parseCronConfig.js";
import type { CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { computeNextRunAt } from "./CronSchedule.js";
import type { CronFire } from "./CronFire.js";

const DEFAULT_IDLE_POLL_MS = 60_000;
const MIN_TIMER_MS = 250;

export type CronSchedulerDependencies = {
  config: CronConfig;
  store: CronTaskStore;
  fire: CronFire;
  uuid: () => string;
  now: () => Date;
  activeRunCount: () => number;
  logger?: {
    warn: (message: string, data?: Record<string, unknown>) => void;
  };
};

export class CronScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private tickInProgress: Promise<void> | undefined;

  constructor(private readonly deps: CronSchedulerDependencies) {}

  async start(): Promise<void> {
    if (!this.deps.config.enabled || this.stopped) {
      return;
    }
    if (this.running) {
      return;
    }
    this.running = true;
    await this.recalculateAllNextRuns();
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.tickInProgress) {
      await this.tickInProgress.catch(() => undefined);
    }
  }

  poke(): void {
    if (this.stopped || !this.running || !this.deps.config.enabled) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.scheduleNextTick(0);
  }

  /** Public for tests; runs a single scheduler tick. */
  async runTickOnce(): Promise<void> {
    await this.tick();
  }

  private scheduleNextTick(delayMs?: number): void {
    if (this.stopped || !this.running || !this.deps.config.enabled) return;
    const waitMs = Math.max(MIN_TIMER_MS, delayMs ?? this.computeDelayMs());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tickInProgress = this.tick().catch((error: unknown) => {
        this.deps.logger?.warn("cron scheduler tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }) as Promise<void>;
      void this.tickInProgress.then(() => {
        this.tickInProgress = undefined;
        this.scheduleNextTick();
      });
    }, waitMs);
  }

  private computeDelayMs(): number {
    return DEFAULT_IDLE_POLL_MS;
  }

  private async tick(): Promise<void> {
    const now = this.deps.now();
    const tasks = await this.deps.store.listTasks();
    const dueTasks = tasks.filter((task) => isDue(task, now));
    for (const task of dueTasks) {
      if (this.deps.activeRunCount() >= this.deps.config.maxConcurrentRuns) {
        await this.delayTask(task, now);
        continue;
      }
      const runId = this.deps.uuid();
      void this.deps.fire.runTask(task, runId).catch((error: unknown) => {
        this.deps.logger?.warn("cron fire failed", {
          taskId: task.taskId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async recalculateAllNextRuns(): Promise<void> {
    const now = this.deps.now();
    const tasks = await this.deps.store.listTasks();
    await Promise.all(
      tasks.map(async (task) => {
        if (task.status === "running") {
          await this.deps.store.putTask({ ...task, status: "scheduled", updatedAt: now.toISOString() });
          return;
        }
        if (task.nextRunAt) {
          return;
        }
        const nextRunAt = computeNextRunAt(task.schedule, now)?.toISOString();
        if (!nextRunAt && task.schedule.type === "once") {
          await this.deps.store.deleteTask(task.taskId);
          return;
        }
        await this.deps.store.putTask({ ...task, nextRunAt, updatedAt: now.toISOString() });
      }),
    );
  }

  private async delayTask(task: CronTask, now: Date): Promise<void> {
    const nextRunAt = new Date(now.getTime() + DEFAULT_IDLE_POLL_MS).toISOString();
    await this.deps.store.putTask({
      ...task,
      nextRunAt,
      updatedAt: now.toISOString(),
    });
  }
}

function isDue(task: CronTask, now: Date): boolean {
  if (task.status === "running") {
    return false;
  }
  if (!task.nextRunAt) {
    return false;
  }
  const dueAt = new Date(task.nextRunAt);
  return !Number.isNaN(dueAt.getTime()) && dueAt.getTime() <= now.getTime();
}
