import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CronReminder, CronTask, CronRunRecord } from "../protocol/types.js";

type StoredReminder = CronReminder & { dismissedScopes: Record<string, string> };

/** Durable acknowledgement is independent of chat read state and run-history retention. */
export class CronReminderStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}

  private async read(): Promise<StoredReminder[]> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (data?.version !== 1 || !Array.isArray(data.reminders)
        || data.reminders.some((item: StoredReminder) => !item || !/^[a-f0-9]{64}$/.test(item.id)
          || !['taskId', 'projectKey', 'sessionKey', 'title', 'body', 'createdAt', 'occurrenceAt'].every(key => typeof item[key as keyof CronReminder] === 'string')
          || !['due', 'completed', 'failed'].includes(item.kind) || !Number.isFinite(Date.parse(item.createdAt))
          || !item.dismissedScopes || typeof item.dismissedScopes !== 'object' || Array.isArray(item.dismissedScopes))) {
        throw new Error("Invalid scheduled reminder store; existing bytes were preserved.");
      }
      return data.reminders;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private mutate<T>(operation: (items: StoredReminder[]) => { result: T; changed: boolean }): Promise<T> {
    const work = this.tail.then(async () => {
      const items = await this.read();
      const { result, changed } = operation(items);
      if (changed) {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 1, reminders: items }), { mode: 0o600 });
        await rename(temporary, this.path);
      }
      return result;
    });
    this.tail = work.catch(() => undefined);
    return work;
  }

  async put(reminder: CronReminder): Promise<boolean> {
    return this.mutate(items => {
      if (items.some(item => item.id === reminder.id)) return { result: false, changed: false };
      items.push({ ...reminder, dismissedScopes: {} });
      return { result: true, changed: true };
    });
  }

  async list(scope: string): Promise<CronReminder[]> {
    await this.tail;
    return (await this.read()).filter(item => !Object.hasOwn(item.dismissedScopes, scope))
      .map(({ dismissedScopes: _dismissed, ...item }) => item)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async dismiss(scope: string, id: string, at: string): Promise<boolean> {
    return this.mutate(items => {
      const item = items.find(item => item.id === id);
      if (!item) return { result: false, changed: false };
      if (Object.hasOwn(item.dismissedScopes, scope)) return { result: true, changed: false };
      Object.defineProperty(item.dismissedScopes, scope, { value: at, enumerable: true, writable: true, configurable: true });
      return { result: true, changed: true };
    });
  }
}

export function taskReminder(task: CronTask, kind: CronReminder["kind"], createdAt: string, run?: CronRunRecord): CronReminder {
  const occurrenceAt = run?.scheduledAt ?? task.nextRunAt ?? createdAt;
  const identity = [task.projectKey, task.taskId, kind, run?.runId ?? occurrenceAt];
  return {
    id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    taskId: task.taskId, projectKey: task.projectKey!, sessionKey: task.sessionKey,
    title: task.name || task.message.split("\n")[0].slice(0, 120),
    body: (kind === "due" ? task.message : run?.error?.message || run?.output || task.message).slice(0, 1200),
    kind, createdAt, occurrenceAt, ...(run ? { runId: run.runId } : {}),
  };
}
