import { appendFile, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewayEvent } from "../../gateway/index.js";
import type { CronRunRecord, CronTask } from "../protocol/types.js";
import { cronRunEventsPath, type CronPaths } from "./CronPaths.js";

type CronTaskFile = {
  schemaVersion: 1;
  tasks: CronTask[];
};

export class CronTaskStore {
  constructor(private readonly paths: CronPaths) {}

  async listTasks(): Promise<CronTask[]> {
    return (await this.readTaskFile()).tasks;
  }

  async getTask(taskId: string): Promise<CronTask | undefined> {
    return (await this.listTasks()).find((task) => task.taskId === taskId);
  }

  async putTask(task: CronTask): Promise<void> {
    const file = await this.readTaskFile();
    const index = file.tasks.findIndex((entry) => entry.taskId === task.taskId);
    const nextTasks = [...file.tasks];
    if (index >= 0) {
      nextTasks[index] = task;
    } else {
      nextTasks.push(task);
    }
    await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(nextTasks) });
  }

  async updateTask(taskId: string, update: (task: CronTask) => CronTask | undefined): Promise<CronTask | undefined> {
    const file = await this.readTaskFile();
    let updated: CronTask | undefined;
    const tasks = file.tasks.flatMap((task) => {
      if (task.taskId !== taskId) {
        return [task];
      }
      updated = update(task);
      return updated ? [updated] : [];
    });
    await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(tasks) });
    return updated;
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const file = await this.readTaskFile();
    const tasks = file.tasks.filter((task) => task.taskId !== taskId);
    if (tasks.length === file.tasks.length) {
      return false;
    }
    await this.writeTaskFile({ schemaVersion: 1, tasks: sortTasks(tasks) });
    return true;
  }

  async appendRun(record: CronRunRecord): Promise<void> {
    await mkdir(dirname(this.paths.runHistoryFile), { recursive: true });
    await appendFile(this.paths.runHistoryFile, `${JSON.stringify(record)}\n`, "utf-8");
  }

  async listRuns(limit = 50): Promise<CronRunRecord[]> {
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
    return records.slice(-Math.max(0, limit)).reverse();
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
        return { schemaVersion: 1, tasks: [] };
      }
      return {
        schemaVersion: 1,
        tasks: parsed.tasks.flatMap((task) => (normalizeTask(task) ? [normalizeTask(task)!] : [])),
      };
    } catch {
      return { schemaVersion: 1, tasks: [] };
    }
  }

  private async writeTaskFile(file: CronTaskFile): Promise<void> {
    await mkdir(dirname(this.paths.tasksFile), { recursive: true });
    const tempPath = `${this.paths.tasksFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(file, null, 2), "utf-8");
    try {
      await rename(tempPath, this.paths.tasksFile);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        await copyFile(tempPath, this.paths.tasksFile);
        await unlink(tempPath).catch(() => {});
      } else {
        throw err;
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
  return {
    schemaVersion: 1,
    taskId: candidate.taskId,
    message: candidate.message,
    schedule: candidate.schedule,
    status: candidate.status === "running" ? "running" : "scheduled",
    sessionKey: candidate.sessionKey,
    channelKey: candidate.channelKey,
    projectKey: typeof candidate.projectKey === "string" ? candidate.projectKey : undefined,
    mode: candidate.mode,
    timezone: typeof candidate.timezone === "string" ? candidate.timezone : undefined,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    nextRunAt: typeof candidate.nextRunAt === "string" ? candidate.nextRunAt : undefined,
    lastRunId: typeof candidate.lastRunId === "string" ? candidate.lastRunId : undefined,
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
    finishedAt: typeof candidate.finishedAt === "string" ? candidate.finishedAt : undefined,
    outcome: candidate.outcome,
    error: candidate.error,
  };
}
