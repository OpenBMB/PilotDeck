import type { CronConfig } from "../config/parseCronConfig.js";
import type { CronTask } from "../protocol/types.js";
import type { CronTaskStore } from "../storage/CronTaskStore.js";
import { resolveCronTimezone } from "../CronTimezone.js";
import { computeNextRunAt, cronDayFieldsUseOr, CRON_SCHEDULE_COMPUTATION_VERSION } from "./CronSchedule.js";
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
  private generation = 0;
  private poked = false;

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
    await this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
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
    if (this.tickInProgress) { this.poked = true; return; }
    void this.scheduleNextTick(0);
  }

  /** Public for tests; runs a single scheduler tick. */
  async runTickOnce(): Promise<void> {
    await this.tick();
  }

  private async scheduleNextTick(delayMs?: number): Promise<void> {
    if (this.stopped || !this.running || !this.deps.config.enabled) return;
    const generation = ++this.generation;
    let waitMs = delayMs;
    if (waitMs === undefined) {
      const tasks = await this.deps.store.listTasks();
      const next = tasks.filter((task) => task.status === "scheduled" && task.enabled !== false && task.nextRunAt)
        .reduce((at, task) => Math.min(at, Date.parse(task.nextRunAt!)), Infinity);
      waitMs = Number.isFinite(next) ? Math.max(0, next - this.deps.now().getTime()) : DEFAULT_IDLE_POLL_MS;
      if (waitMs <= 0 && this.deps.activeRunCount() >= this.deps.config.maxConcurrentRuns) waitMs = 1_000;
    }
    if (generation !== this.generation || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tickInProgress = this.tick().catch((error: unknown) => {
        this.deps.logger?.warn("cron scheduler tick failed", { error: String(error) });
      });
      void this.tickInProgress.finally(() => {
        this.tickInProgress = undefined;
        const delay = this.poked ? 0 : undefined;
        this.poked = false;
        void this.scheduleNextTick(delay).catch((error) => this.deps.logger?.warn("cron timer failed", { error: String(error) }));
      });
    }, Math.max(MIN_TIMER_MS, Math.min(DEFAULT_IDLE_POLL_MS, waitMs)));
  }

  private async tick(): Promise<void> {
    const now = this.deps.now();
    const tasks = await this.deps.store.listTasks();
    const dueTasks = tasks.filter((task) => isDue(task, now));
    for (const task of dueTasks) {
      if (this.deps.activeRunCount() >= this.deps.config.maxConcurrentRuns) {
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
        if (task.status !== "scheduled" || task.enabled === false) return;
        if (task.schedule.type !== "cron") {
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
        const cachedRunAt = task.nextRunAt ? Date.parse(task.nextRunAt) : NaN;
        const hasV2CachedRun = task.scheduleComputationVersion === 2 && Number.isFinite(cachedRunAt);
        // Only restricted day fields change from AND to OR. Reuse unaffected
        // caches instead of searching up to a year's worth of calendar minutes.
        const reuseCachedRun = hasV2CachedRun
          && (cachedRunAt <= now.getTime() || !cronDayFieldsUseOr(schedule.expression));
        const computedRunAt = reuseCachedRun ? undefined : computeNextRunAt(schedule, now, timezone);
        // OR can bring a run forward, never push a pending v2 run back. A future
        // cache may be an overdue run deferred by the concurrency limit.
        const nextRunAt = hasV2CachedRun && (!computedRunAt || cachedRunAt <= computedRunAt.getTime())
          ? task.nextRunAt
          : computedRunAt?.toISOString();
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


}

function isDue(task: CronTask, now: Date): boolean {
  if (task.status !== "scheduled" || task.enabled === false) {
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
