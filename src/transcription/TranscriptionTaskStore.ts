import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

import {
  TRANSCRIPTION_AUDIO_DIRECTORY,
  TRANSCRIPTION_PROCESSING_RECORD_FILE,
  TRANSCRIPTION_TASK_DIRECTORY,
  TRANSCRIPTION_TASK_INFO_FILE,
  type TranscriptionProcessingRecord,
  type TranscriptionTaskInfo,
  type TranscriptionTaskParameters,
  type TranscriptionTaskStatus,
} from "./types.js";

export class TranscriptionTaskStore {
  constructor(private readonly workspaceRoot: string) {}

  get rootDirectory(): string {
    return join(this.workspaceRoot, TRANSCRIPTION_TASK_DIRECTORY);
  }

  getTaskDirectory(taskId: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error("Invalid transcription task id.");
    return join(this.rootDirectory, taskId);
  }

  async create(input: {
    sourcePath: string;
    sourceHash: string;
    sourceBytes: number;
    sourceCreatedAt: string;
    parameters: TranscriptionTaskParameters;
    now: Date;
  }): Promise<{ task: TranscriptionTaskInfo; taskDirectory: string }> {
    const id = randomUUID();
    const taskDirectory = this.getTaskDirectory(id);
    const audioDirectory = join(taskDirectory, TRANSCRIPTION_AUDIO_DIRECTORY);
    await mkdir(audioDirectory, { recursive: true });
    const audioName = sanitizeFileName(basename(input.sourcePath));
    const originalAudio = join(audioDirectory, audioName);
    await copyFile(input.sourcePath, originalAudio);
    const at = input.now.toISOString();
    const task: TranscriptionTaskInfo = {
      id,
      status: "created",
      createdAt: at,
      updatedAt: at,
      source: {
        originalFileName: audioName,
        sha256: input.sourceHash,
        bytes: input.sourceBytes,
        sourceCreatedAt: input.sourceCreatedAt,
      },
      parameters: input.parameters,
      artifacts: { originalAudio: relative(taskDirectory, originalAudio) },
      completedSteps: [],
    };
    await this.writeTask(taskDirectory, task);
    await this.writeProcessingRecord(taskDirectory, {
      taskId: id,
      events: [{ at, status: "created", message: "Task created." }],
    });
    return { task, taskDirectory };
  }

  async read(taskId: string): Promise<{ task: TranscriptionTaskInfo; taskDirectory: string }> {
    const taskDirectory = this.getTaskDirectory(taskId);
    const task = await this.readTask(taskDirectory);
    return { task, taskDirectory };
  }

  async readByDirectory(taskDirectory: string): Promise<{ task: TranscriptionTaskInfo; taskDirectory: string }> {
    return { task: await this.readTask(taskDirectory), taskDirectory };
  }

  async update(
    taskDirectory: string,
    update: (task: TranscriptionTaskInfo) => TranscriptionTaskInfo,
  ): Promise<TranscriptionTaskInfo> {
    const task = await this.readTask(taskDirectory);
    const next = update(task);
    await this.writeTask(taskDirectory, next);
    return next;
  }

  async setStatus(
    taskDirectory: string,
    status: TranscriptionTaskStatus,
    message: string,
    now: Date,
    step?: "transcribe" | "polish" | "minutes",
  ): Promise<TranscriptionTaskInfo> {
    const at = now.toISOString();
    const task = await this.update(taskDirectory, (current) => ({ ...current, status, updatedAt: at }));
    const record = await this.readProcessingRecord(taskDirectory, task.id);
    record.events.push({ at, status, message, ...(step ? { step } : {}) });
    await this.writeProcessingRecord(taskDirectory, record);
    return task;
  }

  async recordEvent(
    taskDirectory: string,
    message: string,
    now: Date,
    step?: "transcribe" | "polish" | "minutes",
  ): Promise<void> {
    const task = await this.readTask(taskDirectory);
    const record = await this.readProcessingRecord(taskDirectory, task.id);
    record.events.push({ at: now.toISOString(), status: task.status, message, ...(step ? { step } : {}) });
    await this.writeProcessingRecord(taskDirectory, record);
  }

  async findDuplicate(sourceHash: string, sourceBytes: number): Promise<{ task: TranscriptionTaskInfo; taskDirectory: string } | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDirectory);
    } catch {
      return undefined;
    }
    let matched: { task: TranscriptionTaskInfo; taskDirectory: string } | undefined;
    for (const id of entries) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) continue;
      const taskDirectory = join(this.rootDirectory, id);
      try {
        const task = await this.readTask(taskDirectory);
        if (task.source.sha256 === sourceHash && task.source.bytes === sourceBytes
          && (!matched || task.createdAt > matched.task.createdAt)) {
          matched = { task, taskDirectory };
        }
      } catch {
        // A malformed legacy task record must not block a new transcription.
      }
    }
    return matched;
  }

  async writeArtifactIfMissing(taskDirectory: string, name: string, content: string): Promise<{ path: string; created: boolean }> {
    const path = join(taskDirectory, name);
    try {
      await stat(path);
      return { path, created: false };
    } catch {
      await atomicWrite(path, content);
      return { path, created: true };
    }
  }

  async removeArtifact(taskDirectory: string, name: string): Promise<void> {
    await rm(join(taskDirectory, name), { force: true });
  }

  async readArtifact(taskDirectory: string, name: string): Promise<string | undefined> {
    try {
      return await readFile(join(taskDirectory, name), "utf8");
    } catch {
      return undefined;
    }
  }

  private async readTask(taskDirectory: string): Promise<TranscriptionTaskInfo> {
    const raw = await readFile(join(taskDirectory, TRANSCRIPTION_TASK_INFO_FILE), "utf8");
    return JSON.parse(raw) as TranscriptionTaskInfo;
  }

  private async writeTask(taskDirectory: string, task: TranscriptionTaskInfo): Promise<void> {
    await atomicWrite(join(taskDirectory, TRANSCRIPTION_TASK_INFO_FILE), `${JSON.stringify(task, null, 2)}\n`);
  }

  private async readProcessingRecord(taskDirectory: string, taskId: string): Promise<TranscriptionProcessingRecord> {
    try {
      return JSON.parse(await readFile(join(taskDirectory, TRANSCRIPTION_PROCESSING_RECORD_FILE), "utf8")) as TranscriptionProcessingRecord;
    } catch {
      return { taskId, events: [] };
    }
  }

  private async writeProcessingRecord(taskDirectory: string, record: TranscriptionProcessingRecord): Promise<void> {
    await atomicWrite(join(taskDirectory, TRANSCRIPTION_PROCESSING_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

function sanitizeFileName(value: string): string {
  const normalized = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return normalized || "recording";
}
