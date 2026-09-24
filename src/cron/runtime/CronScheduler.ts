import type { CronConfig } from "../config/parseCronConfig.js";
import type { CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { resolveCronTimezone } from "../CronTimezone.js";
import { computeNextRunAt, CRON_SCHEDULE_COMPUTATION_VERSION } from "./CronSchedule.js";
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
        if (task.schedule.type === "once") {
          if (task.nextRunAt) {
            return;
          }
          const nextRunAt = computeNextRunAt(task.schedule, now)?.toISOString();
          if (!nextRunAt) {
            await this.deps.store.updateTask(task.taskId, (current) => matchesTaskSnapshot(current, task) ? undefined : current);
            return;
          }
          await this.deps.store.updateTask(task.taskId, (current) => {
            if (!matchesTaskSnapshot(current, task)) return current;
            return {
              ...current,
              nextRunAt,
              revision: (current.revision ?? 0) + 1,
              updatedAt: now.toISOString(),
            };
          });
          return;
        }

        if (task.scheduleComputationVersion === CRON_SCHEDULE_COMPUTATION_VERSION && task.nextRunAt) {
          return;
        }
        const timezone = resolveCronTimezone(
          task.schedule.timezone,
          task.timezone,
          this.deps.config.timezone,
        );
        const schedule = { ...task.schedule, timezone };
        // Version 2 used AND for restricted day fields. Refresh future runs, but keep
        // an already-due run so upgrading does not skip the scheduler's catch-up.
        const preserveDueRun = task.scheduleComputationVersion === 2
          && task.nextRunAt !== undefined
          && new Date(task.nextRunAt).getTime() <= now.getTime();
        const nextRunAt = preserveDueRun
          ? task.nextRunAt
          : computeNextRunAt(schedule, now, timezone)?.toISOString();
        await this.deps.store.updateTask(task.taskId, (current) => {
          if (!matchesTaskSnapshot(current, task)) return current;
          return {
            ...current,
            schedule,
            timezone,
            status: "scheduled",
            nextRunAt,
            revision: (current.revision ?? 0) + 1,
            scheduleComputationVersion: CRON_SCHEDULE_COMPUTATION_VERSION,
            updatedAt: now.toISOString(),
          };
        });
      }),
    );
  }

  private async delayTask(task: CronTask, now: Date): Promise<void> {
    const nextRunAt = new Date(now.getTime() + DEFAULT_IDLE_POLL_MS).toISOString();
    await this.deps.store.updateTask(task.taskId, (current) => {
      if (!matchesTaskSnapshot(current, task) || current.status !== "scheduled") return current;
      return {
        ...current,
        nextRunAt,
        revision: (current.revision ?? 0) + 1,
        updatedAt: now.toISOString(),
      };
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

function matchesTaskSnapshot(current: CronTask, snapshot: CronTask): boolean {
  return current.status === snapshot.status
    && (current.revision ?? 0) === (snapshot.revision ?? 0)
    && current.nextRunAt === snapshot.nextRunAt
    && current.lastRunId === snapshot.lastRunId;
}
