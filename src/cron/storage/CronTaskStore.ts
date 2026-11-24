import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewayEvent } from "../../gateway/index.js";
import { resolveProjectIdentityPath } from "../../pilot/paths.js";
import type { CronRunRecord, CronTask, CronTaskChange } from "../protocol/types.js";
import { cronRunEventsPath, type CronPaths } from "./CronPaths.js";
import { isValidCalendarSchedule, isValidCronExpression } from "../runtime/CronSchedule.js";
import { isValidCronTimezone } from "../CronTimezone.js";

type CronTaskFile = {
  schemaVersion: 1;
  tasks: CronTask[];
};

const taskFileMutationTails = new Map<string, Promise<void>>();

export class CronTaskStore {
  private readonly listeners = new Set<(change: CronTaskChange) => void>();
  constructor(private readonly paths: CronPaths) {}

  subscribe(listener: (change: CronTaskChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(taskId: string, task?: CronTask, projectKey?: string): void {
    for (const listener of this.listeners) {
      try { listener({ taskId, task, projectKey: task?.projectKey ?? projectKey }); }
      catch { /* A failed observer must not undo a durable mutation. */ }
    }
  }

  async listTasks(): Promise<CronTask[]> {
    return (await this.readTaskFile()).tasks;
  }

  async getTask(taskId: string, projectKey?: string): Promise<CronTask | undefined> {
    return this.findTask(await this.listTasks(), taskId, projectKey);
  }

  async putTask(task: CronTask): Promise<void> {
    await this.mutateTaskFile(async (file) => {
      const index = file.tasks.findIndex((entry) => entry.taskId === task.taskId);
      const nextTasks = [...file.tasks];
      if (index >= 0) {
        nextTasks[index] = task;
      } else {
        nextTasks.push(task);
      }
      await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(nextTasks) });
      this.changed(task.taskId, task);
    });
  }

  async replaceTask(task: CronTask): Promise<boolean> {
    return this.mutateTaskFile(async (file) => {
      const index = file.tasks.findIndex((entry) => entry.taskId === task.taskId);
      if (index < 0) {
        return false;
      }
      const nextTasks = [...file.tasks];
      nextTasks[index] = task;
      await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(nextTasks) });
      this.changed(task.taskId, task);
      return true;
    });
  }

  async updateTask(taskId: string, update: (task: CronTask) => CronTask | undefined): Promise<CronTask | undefined> {
    return this.mutateTaskFile(async (file) => {
      let updated: CronTask | undefined;
      const tasks = file.tasks.flatMap((task) => {
        if (task.taskId !== taskId) {
          return [task];
        }
        updated = update(task);
        return updated ? [updated] : [];
      });
      await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(tasks) });
      const previous = file.tasks.find(task => task.taskId === taskId);
      if (JSON.stringify(previous) !== JSON.stringify(updated)) this.changed(taskId, updated, previous?.projectKey);
      return updated;
    });
  }

  async deleteTask(taskId: string, projectKey?: string): Promise<boolean> {
    return this.mutateTaskFile(async (file) => {
      const task = this.findTask(file.tasks, taskId, projectKey);
      if (!task) return false;
      const tasks = file.tasks.filter((entry) => entry.taskId !== taskId);
      await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(tasks) });
      this.changed(taskId, undefined, task.projectKey);
      return true;
    });
  }

  private findTask(tasks: CronTask[], taskId: string, projectKey?: string): CronTask | undefined {
    const task = tasks.find((entry) => entry.taskId === taskId);
    if (task && (projectKey === undefined
        || resolveProjectIdentityPath(task.projectKey ?? this.paths.projectKey) === resolveProjectIdentityPath(projectKey))) {
      return task;
    }
    return undefined;
  }

  async appendRun(record: CronRunRecord): Promise<void> {
    const key = this.paths.runHistoryFile;
    const previous = taskFileMutationTails.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await mkdir(dirname(key), { recursive: true });
      await appendFile(key, `${JSON.stringify(record)}\n`, "utf-8");
      if (!record.finishedAt) return;
      const runs = await this.listRuns(Number.MAX_SAFE_INTEGER);
      const counts = new Map<string, number>();
      const cutoff = Date.parse(record.finishedAt) - 30 * 24 * 60 * 60_000;
      const kept = runs.filter((run) => {
        const count = counts.get(run.taskId) ?? 0;
        if (count >= 200 || (count > 0 && Date.parse(run.startedAt) < cutoff)) return false;
        counts.set(run.taskId, count + 1);
        return true;
      });
      const temp = `${key}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, kept.reverse().map((run) => JSON.stringify(run)).join("\n") + "\n", "utf-8");
        await rename(temp, key);
      } finally { await unlink(temp).catch(() => undefined); }
      const ids = new Set(kept.map((run) => run.runId));
      await Promise.all(runs.filter((run) => !ids.has(run.runId)).map((run) => unlink(cronRunEventsPath(this.paths, run.runId)).catch(() => undefined)));
    });
    const tail = operation.then(() => undefined, () => undefined);
    taskFileMutationTails.set(key, tail);
    try { await operation; } finally { if (taskFileMutationTails.get(key) === tail) taskFileMutationTails.delete(key); }
  }

  async listRuns(limit = 50, taskId?: string, beforeRunId?: string): Promise<CronRunRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.paths.runHistoryFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const records = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return normalizeRun(parsed) ? [normalizeRun(parsed)!] : [];
        } catch {
          return [];
        }
      });
    const unique = new Map<string, CronRunRecord>();
    for (const record of records) unique.set(record.runId, record);
    let runs = [...unique.values()].reverse().filter((run) => !taskId || run.taskId === taskId);
    if (beforeRunId) {
      const index = runs.findIndex((run) => run.runId === beforeRunId);
      runs = index < 0 ? [] : runs.slice(index + 1);
    }
    return runs.slice(0, Math.max(0, limit));
  }

  async appendRunEvent(runId: string, event: GatewayEvent): Promise<void> {
    const path = cronRunEventsPath(this.paths, runId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ schemaVersion: 1, runId, event })}\n`, "utf-8");
  }

  private async readTaskFile(): Promise<CronTaskFile> {
    let raw: string;
    try {
      raw = await readFile(this.paths.tasksFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, tasks: [] };
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<CronTaskFile>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
        throw new Error("Unsupported task store schema.");
      }
      const tasks = parsed.tasks.map(normalizeTask);
      if (tasks.some((task) => !task)) throw new Error("Invalid task record.");
      if (new Set(tasks.map((task) => task!.taskId)).size !== tasks.length) throw new Error("Duplicate task identity.");
      return {
        schemaVersion: 1,
        tasks: tasks as CronTask[],
      };
    } catch (error) {
      throw new Error(`Cron task store is damaged; the original file was preserved: ${this.paths.tasksFile}`, { cause: error });
    }
  }

  private async writeTaskFile(file: CronTaskFile): Promise<void> {
    await mkdir(dirname(this.paths.tasksFile), { recursive: true });
    const tempPath = `${this.paths.tasksFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(file, null, 2), "utf-8");
      try {
        await rename(tempPath, this.paths.tasksFile);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          await copyFile(tempPath, this.paths.tasksFile);
        } else {
          throw err;
        }
      }
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }

  private async mutateTaskFile<T>(mutation: (file: CronTaskFile) => Promise<T>): Promise<T> {
    const key = this.paths.tasksFile;
    const previous = taskFileMutationTails.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => mutation(await this.readTaskFile()));
    const tail = operation.then(() => undefined, () => undefined);
    taskFileMutationTails.set(key, tail);
    try {
      return await operation;
    } finally {
      if (taskFileMutationTails.get(key) === tail) {
        taskFileMutationTails.delete(key);
      }
    }
  }
}

function sortTasks(tasks: CronTask[]): CronTask[] {
  return [...tasks].sort((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? ""));
}

function normalizeTask(value: unknown): CronTask | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CronTask>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.message !== "string" ||
    !candidate.schedule ||
    typeof candidate.sessionKey !== "string" ||
    typeof candidate.channelKey !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return undefined;
  }
  if (candidate.schedule.type === "once" && typeof candidate.schedule.runAt !== "string") {
    return undefined;
  }
  if (candidate.schedule.type === "cron" && typeof candidate.schedule.expression !== "string") {
    return undefined;
  }
  if (!["once", "cron", "calendar", "interval", "monthly"].includes(candidate.schedule.type)) return undefined;
  if (candidate.schedule.type === "once" && !Number.isFinite(Date.parse(candidate.schedule.runAt))) return undefined;
  if (candidate.schedule.type === "cron" && !isValidCronExpression(candidate.schedule.expression)) return undefined;
  if (candidate.schedule.type === "calendar" && !isValidCalendarSchedule(candidate.schedule)) return undefined;
  if (candidate.schedule.type === "monthly" && (![1, 2, 3, 4, -1].includes(candidate.schedule.ordinal)
    || !Number.isInteger(candidate.schedule.weekday) || candidate.schedule.weekday < 0 || candidate.schedule.weekday > 6
    || !Number.isInteger(candidate.schedule.hour) || candidate.schedule.hour < 0 || candidate.schedule.hour > 23
    || !Number.isInteger(candidate.schedule.minute) || candidate.schedule.minute < 0 || candidate.schedule.minute > 59
    || !isValidCronTimezone(candidate.schedule.timezone))) return undefined;
  if (candidate.schedule.type === "interval"
    && (!Number.isSafeInteger(candidate.schedule.everySeconds) || candidate.schedule.everySeconds < 60
      || !Number.isFinite(Date.parse(candidate.schedule.anchorAt)))) return undefined;
  return {
    schemaVersion: 1,
    taskId: candidate.taskId,
    name: typeof candidate.name === "string" ? candidate.name : candidate.message.trim().split(/\r?\n/, 1)[0].slice(0, 120),
    message: candidate.message,
    schedule: candidate.schedule,
    status: ["scheduled", "running", "paused", "completed", "failed", "missed"].includes(candidate.status!) ? candidate.status! : "scheduled",
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : !["paused", "completed", "failed", "missed"].includes(candidate.status!),
    executionMode: candidate.executionMode ?? "persistent",
    workspaceCwd: typeof candidate.workspaceCwd === "string" ? candidate.workspaceCwd : undefined,
    targetSessionKey: candidate.targetSessionKey,
    notificationPolicy: candidate.notificationPolicy ?? "all",
    workspaceMode: candidate.workspaceMode ?? "local",
    modelSelection: candidate.modelSelection,
    statusDetail: candidate.statusDetail,
    lastRun: candidate.lastRun ? normalizeRun(candidate.lastRun) : undefined,
    sessionKey: candidate.sessionKey,
    channelKey: candidate.channelKey,
    projectKey: typeof candidate.projectKey === "string" ? candidate.projectKey : undefined,
    mode: candidate.mode === "bypassPermissions" ? "bypassPermissions" : "default",
    timezone: typeof candidate.timezone === "string" ? candidate.timezone : undefined,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    nextRunAt: typeof candidate.nextRunAt === "string" ? candidate.nextRunAt : undefined,
    lastRunId: typeof candidate.lastRunId === "string" ? candidate.lastRunId : undefined,
    revision: Number.isSafeInteger(candidate.revision) && candidate.revision! >= 0
      ? candidate.revision
      : 0,
    scheduleComputationVersion: candidate.scheduleComputationVersion === 2 || candidate.scheduleComputationVersion === 3
      ? candidate.scheduleComputationVersion
      : undefined,
    originSessionKey: typeof candidate.originSessionKey === "string" ? candidate.originSessionKey : undefined,
    originProjectKey: typeof candidate.originProjectKey === "string" ? candidate.originProjectKey : undefined,
    originChannelKey: typeof candidate.originChannelKey === "string" ? candidate.originChannelKey : undefined,
  };
}

function normalizeRun(value: unknown): CronRunRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CronRunRecord>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.runId !== "string" ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.sessionKey !== "string" ||
    typeof candidate.startedAt !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    runId: candidate.runId,
    taskId: candidate.taskId,
    sessionKey: candidate.sessionKey,
    projectKey: typeof candidate.projectKey === "string" ? candidate.projectKey : undefined,
    startedAt: candidate.startedAt,
    scheduledAt: candidate.scheduledAt,
    trigger: candidate.trigger,
    taskName: candidate.taskName,
    message: candidate.message,
    output: candidate.output,
    artifacts: candidate.artifacts,
    workspaceCwd: candidate.workspaceCwd,
    deliveryStatus: candidate.deliveryStatus,
    deliveryError: candidate.deliveryError,
    finishedAt: typeof candidate.finishedAt === "string" ? candidate.finishedAt : undefined,
    outcome: candidate.outcome,
    error: candidate.error,
  };
}
