import { createHash } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { PilotDeckToolRuntimeError } from "../tool/protocol/errors.js";
import type { PilotTransSpeechEnabledConfig } from "../pilot/config/types.js";
import { chatAttachmentMaxFileSizeBytes } from "../pilot/config/parseWebUiConfig.js";
import { TransSpeechClient, TransSpeechClientError } from "./TransSpeechClient.js";
import { TranscriptionTaskStore } from "./TranscriptionTaskStore.js";
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  TRANSCRIPTION_MINUTES_FILE,
  TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE,
  TRANSCRIPTION_TRANSCRIPT_FILE,
  type TransSpeechTranscription,
  type TranscriptionTaskInfo,
  type TranscriptionTaskArtifacts,
  type TranscriptionTaskResult,
  type TranscriptionTaskStatus,
} from "./types.js";

export type TranscriptionServiceOptions = {
  config: PilotTransSpeechEnabledConfig;
  /** Parsed from webui.attachments.maxFileSizeMB by the local gateway runtime. */
  maxFileSizeBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type StartTranscriptionInput = {
  audioPath: string;
  forceDuplicate?: boolean;
  includeActions?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string, status: TranscriptionTaskStatus) => void;
};

export type TranscriptionServiceResult = TranscriptionTaskResult;

class TaskMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(taskDirectory: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(taskDirectory) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.tails.set(taskDirectory, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(taskDirectory) === tail) this.tails.delete(taskDirectory);
    }
  }
}

const activeControllers = new Map<string, AbortController>();
const taskMutationQueue = new TaskMutationQueue();
const workspaceTaskCreationQueue = new TaskMutationQueue();
const cancellationRequests = new Set<string>();

export class TranscriptionService {
  private readonly client: TransSpeechClient;
  private readonly now: () => Date;
  private readonly maxFileSizeBytes: number;

  constructor(private readonly options: TranscriptionServiceOptions) {
    this.client = new TransSpeechClient({
      baseUrl: options.config.baseUrl,
      timeoutMs: options.config.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    this.now = options.now ?? (() => new Date());
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? chatAttachmentMaxFileSizeBytes(undefined);
  }

  async start(workspaceRoot: string, input: StartTranscriptionInput): Promise<TranscriptionServiceResult> {
    const source = await validateUploadedAudio(workspaceRoot, input.audioPath, this.maxFileSizeBytes);
    const sourceHash = await hashFile(source.path);
    const store = new TranscriptionTaskStore(workspaceRoot);
    const actions = input.includeActions ?? this.options.config.generate.actions;
    const parameters = {
      language: this.options.config.language,
      asrProfile: this.options.config.asrProfile,
      diarize: this.options.config.diarize,
      polish: this.options.config.generate.polish,
      minutes: this.options.config.generate.minutes || actions,
      actions,
    };
    const result = await workspaceTaskCreationQueue.run(store.rootDirectory, async () => {
      const duplicate = await store.findDuplicate(sourceHash, source.bytes);
      if (duplicate && !input.forceDuplicate) return { kind: "duplicate" as const, duplicate };
      const created = await store.create({
        sourcePath: source.path,
        sourceHash,
        sourceBytes: source.bytes,
        sourceCreatedAt: source.createdAt,
        parameters,
        now: this.now(),
      });
      return { kind: "created" as const, created };
    });
    if (result.kind === "duplicate") {
      return { task: result.duplicate.task, taskDirectory: result.duplicate.taskDirectory, duplicateTaskId: result.duplicate.task.id };
    }
    return this.process(result.created.taskDirectory, result.created.task, store, input.signal, input.onProgress);
  }

  async retry(
    workspaceRoot: string,
    taskId: string,
    input: Pick<StartTranscriptionInput, "signal" | "onProgress"> = {},
  ): Promise<TranscriptionServiceResult> {
    const store = new TranscriptionTaskStore(workspaceRoot);
    const current = await store.read(taskId);
    if (current.task.status === "pending_review") {
      return current;
    }
    return this.process(current.taskDirectory, current.task, store, input.signal, input.onProgress);
  }

  async cancel(workspaceRoot: string, taskId: string): Promise<TranscriptionServiceResult> {
    const store = new TranscriptionTaskStore(workspaceRoot);
    const current = await store.read(taskId);
    if (isTerminal(current.task.status)) return current;
    cancellationRequests.add(current.taskDirectory);
    const controller = activeControllers.get(current.taskDirectory);
    controller?.abort(new Error("Recording task cancelled by user."));
    try {
      const task = await this.markCancelled(store, current.taskDirectory, "Task cancelled. No further processing will be started.");
      return { task, taskDirectory: current.taskDirectory };
    } finally {
      if (!controller) cancellationRequests.delete(current.taskDirectory);
    }
  }

  private async process(
    taskDirectory: string,
    initialTask: TranscriptionTaskInfo,
    store: TranscriptionTaskStore,
    parentSignal?: AbortSignal,
    onProgress?: (message: string, status: TranscriptionTaskStatus) => void,
  ): Promise<TranscriptionServiceResult> {
    if (activeControllers.has(taskDirectory)) {
      throw new PilotDeckToolRuntimeError("tool_execution_failed", "Recording task is already in progress.", { taskId: initialTask.id });
    }
    const controller = new AbortController();
    const unlink = forwardAbort(parentSignal, controller);
    activeControllers.set(taskDirectory, controller);
    let release: (() => void) | undefined;
    try {
      throwIfCancelled(taskDirectory, controller.signal);
      release = await workspaceLimiter.acquire(taskDirectoryWorkspaceKey(taskDirectory), this.options.config.maxConcurrentTasks, controller.signal);
      const task = (await store.read(initialTask.id)).task;
      if (task.status === "cancelled") return { task, taskDirectory };

      await this.client.health(controller.signal);
      let transcript = await store.readArtifact(taskDirectory, TRANSCRIPTION_TRANSCRIPT_FILE);
      let transcriptText: string | undefined;
      if (!transcript) {
        await this.transition(store, taskDirectory, controller.signal, "transcribing", "Calling Trans-Speech transcription.", "transcribe", onProgress);
        const sourcePath = await resolveStoredAudio(taskDirectory, task);
        const response = await this.client.transcribe({
          audioPath: sourcePath,
          language: task.parameters.language,
          asrProfile: task.parameters.asrProfile,
          diarize: task.parameters.diarize,
        }, controller.signal);
        throwIfCancelled(taskDirectory, controller.signal);
        transcriptText = rawTranscriptText(response, task.parameters.diarize);
        transcript = await this.commitArtifact(store, taskDirectory, controller.signal, TRANSCRIPTION_TRANSCRIPT_FILE, formatTranscript(task, response, transcriptText), (value, transcriptPath) => ({
          ...value,
          status: "transcribed",
          updatedAt: this.now().toISOString(),
          source: {
            ...value.source,
            ...(response.durationSeconds !== undefined ? { durationSeconds: response.durationSeconds } : {}),
          },
          artifacts: { ...value.artifacts, transcript: relative(taskDirectory, transcriptPath) },
          completedSteps: addStep(value.completedSteps, "transcribe"),
          failure: undefined,
        }));
        await this.transition(store, taskDirectory, controller.signal, "transcribed", "Transcript saved.", "transcribe", onProgress);
      }

      const current = (await store.read(initialTask.id)).task;
      transcriptText ??= await sourceTextFromTranscript(store, taskDirectory);
      let polished = await store.readArtifact(taskDirectory, TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE);
      let polishedText: string | undefined;
      if (current.parameters.polish && !polished) {
        await this.transition(store, taskDirectory, controller.signal, "polishing", "Generating polished transcript.", "polish", onProgress);
        const response = await this.client.enhance({ text: transcriptText, polish: true }, controller.signal);
        throwIfCancelled(taskDirectory, controller.signal);
        polishedText = response.text;
        polished = await this.commitArtifact(store, taskDirectory, controller.signal, TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE, formatPolishedTranscript(current, polishedText), (value, polishedPath) => ({
          ...value,
          status: "transcribed",
          updatedAt: this.now().toISOString(),
          artifacts: { ...value.artifacts, polishedTranscript: relative(taskDirectory, polishedPath) },
          completedSteps: addStep(value.completedSteps, "polish"),
          failure: undefined,
        }));
      }

      const afterPolish = (await store.read(initialTask.id)).task;
      if (afterPolish.parameters.minutes && !await store.readArtifact(taskDirectory, TRANSCRIPTION_MINUTES_FILE)) {
        await this.transition(store, taskDirectory, controller.signal, "generating_minutes", "Generating meeting minutes.", "minutes", onProgress);
        polishedText ??= polished ? extractArtifactBody(polished) : undefined;
        const response = await this.client.enhance({
          text: polishedText ?? transcriptText,
          polish: false,
          minutes: true,
          actions: afterPolish.parameters.actions,
        }, controller.signal);
        throwIfCancelled(taskDirectory, controller.signal);
        if (!response.minutes?.trim()) {
          throw new TransSpeechClientError("invalid_response", "Trans-Speech enhancement response did not contain meeting minutes.");
        }
        const minutes = await this.commitArtifact(store, taskDirectory, controller.signal, TRANSCRIPTION_MINUTES_FILE, formatMinutes(afterPolish, response.minutes, response.actions), (value, minutesPath) => ({
          ...value,
          status: "pending_review",
          updatedAt: this.now().toISOString(),
          artifacts: { ...value.artifacts, minutes: relative(taskDirectory, minutesPath) },
          completedSteps: addStep(value.completedSteps, "minutes"),
          failure: undefined,
        }));
        if (afterPolish.parameters.actions) {
          await this.runWhileActive(taskDirectory, controller.signal, () => store.recordEvent(
            taskDirectory,
            response.actions.length > 0 ? `待办事项提取结果：已识别 ${response.actions.length} 项。` : "待办事项提取结果：未识别到明确待办事项。",
            this.now(),
            "minutes",
          ));
        }
        const completed = (await store.readByDirectory(taskDirectory)).task;
        await this.transition(store, taskDirectory, controller.signal, "pending_review", "All requested results are ready for manual review.", "minutes", onProgress);
        return { task: completed, taskDirectory };
      }

      const completed = await this.updateWhileActive(store, taskDirectory, controller.signal, (value) => ({
        ...value,
        status: "pending_review",
        updatedAt: this.now().toISOString(),
        failure: undefined,
      }));
      await this.transition(store, taskDirectory, controller.signal, "pending_review", "All requested results are ready for manual review.", undefined, onProgress);
      return { task: completed, taskDirectory };
    } catch (error) {
      if (isAbortError(error, controller.signal)) {
        const cancelled = await this.markCancelled(store, taskDirectory);
        throw new PilotDeckToolRuntimeError("tool_aborted", "Recording task cancelled. Existing results were kept.", { taskId: cancelled.id });
      }
      const failed = await this.markFailure(store, taskDirectory, error);
      throw toToolError(error, failed);
    } finally {
      activeControllers.delete(taskDirectory);
      cancellationRequests.delete(taskDirectory);
      release?.();
      unlink?.();
    }
  }

  private async transition(
    store: TranscriptionTaskStore,
    taskDirectory: string,
    signal: AbortSignal,
    status: TranscriptionTaskStatus,
    message: string,
    step: "transcribe" | "polish" | "minutes" | undefined,
    onProgress: ((message: string, status: TranscriptionTaskStatus) => void) | undefined,
  ): Promise<void> {
    await this.runWhileActive(taskDirectory, signal, () => store.setStatus(taskDirectory, status, message, this.now(), step));
    onProgress?.(message, status);
  }

  private async commitArtifact(
    store: TranscriptionTaskStore,
    taskDirectory: string,
    signal: AbortSignal,
    name: string,
    content: string,
    update: (task: TranscriptionTaskInfo, path: string) => TranscriptionTaskInfo,
  ): Promise<string> {
    return this.runWhileActive(taskDirectory, signal, async () => {
      const artifact = await store.writeArtifactIfMissing(taskDirectory, name, content);
      try {
        await store.update(taskDirectory, (task) => update(task, artifact.path));
        throwIfCancelled(taskDirectory, signal);
        return artifact.path;
      } catch (error) {
        if (artifact.created && isCancelled(taskDirectory, signal)) {
          await store.removeArtifact(taskDirectory, name);
          await store.update(taskDirectory, (task) => ({
            ...task,
            artifacts: removeArtifactReference(task.artifacts, name),
            completedSteps: task.completedSteps.filter((step) => step !== stepForArtifact(name)),
          }));
        }
        throw error;
      }
    });
  }

  private async updateWhileActive(
    store: TranscriptionTaskStore,
    taskDirectory: string,
    signal: AbortSignal,
    update: (task: TranscriptionTaskInfo) => TranscriptionTaskInfo,
  ): Promise<TranscriptionTaskInfo> {
    return this.runWhileActive(taskDirectory, signal, () => store.update(taskDirectory, update));
  }

  private async runWhileActive<T>(taskDirectory: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    return taskMutationQueue.run(taskDirectory, async () => {
      throwIfCancelled(taskDirectory, signal);
      const result = await operation();
      throwIfCancelled(taskDirectory, signal);
      return result;
    });
  }

  private async markCancelled(
    store: TranscriptionTaskStore,
    taskDirectory: string,
    message = "Task cancelled. Existing results were kept.",
  ): Promise<TranscriptionTaskInfo> {
    return taskMutationQueue.run(taskDirectory, async () => {
      const current = await store.readByDirectory(taskDirectory);
      if (current.task.status === "cancelled") return current.task;
      const now = this.now();
      const task = await store.update(taskDirectory, (value) => ({
        ...value,
        status: "cancelled",
        updatedAt: now.toISOString(),
        cancelledAt: now.toISOString(),
      }));
      await store.setStatus(taskDirectory, "cancelled", message, now);
      return task;
    });
  }

  private async markFailure(store: TranscriptionTaskStore, taskDirectory: string, error: unknown): Promise<TranscriptionTaskInfo> {
    return taskMutationQueue.run(taskDirectory, async () => {
      const now = this.now();
      const current = await store.readByDirectory(taskDirectory);
      if (current.task.status === "cancelled") return current.task;
      const step = failureStep(current.task);
      const details = errorMessage(error);
      const status = current.task.completedSteps.includes("transcribe") ? "partial" : "failed";
      const task = await store.update(taskDirectory, (value) => ({
        ...value,
        status,
        updatedAt: now.toISOString(),
        failure: { step, code: errorCode(error), message: details, at: now.toISOString() },
      }));
      await store.setStatus(taskDirectory, status, details, now, step);
      return task;
    });
  }
}

async function validateUploadedAudio(
  workspaceRoot: string,
  value: string,
  maxFileSizeBytes: number,
): Promise<{ path: string; bytes: number; createdAt: string }> {
  if (!value || value.includes("\0")) throw new PilotDeckToolRuntimeError("invalid_tool_input", "audio_path must be a non-empty file path.");
  const currentUploadRoot = resolve(workspaceRoot, ".tmp", "chat-uploads");
  const legacyUploadRoot = resolve(workspaceRoot, ".tmp", "chat-attachments");
  const sourcePath = resolve(isAbsolute(value) ? value : join(workspaceRoot, value));
  const [realCurrentUploadRoot, realLegacyUploadRoot] = await Promise.all([
    realpath(currentUploadRoot).catch(() => currentUploadRoot),
    realpath(legacyUploadRoot).catch(() => legacyUploadRoot),
  ]);
  const realSource = await realpath(sourcePath).catch(() => undefined);
  if (!realSource) throw new PilotDeckToolRuntimeError("file_not_found", "Uploaded audio file was not found.");
  if (!isCurrentWebUploadFile(realSource, realCurrentUploadRoot) && !isWithin(realSource, realLegacyUploadRoot)) {
    throw new PilotDeckToolRuntimeError("path_not_allowed", "audio_path must reference a Web audio file uploaded in this workspace.");
  }
  const extension = extname(realSource).toLowerCase();
  if (!SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "Only .wav, .mp3, .m4a, and .flac audio files are supported.");
  }
  const info = await stat(realSource);
  if (!info.isFile()) throw new PilotDeckToolRuntimeError("invalid_tool_input", "audio_path must reference a regular file.");
  if (info.size === 0) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "Audio files must not be empty.");
  }
  if (info.size > maxFileSizeBytes) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Audio files must not exceed ${formatMiB(maxFileSizeBytes)}MB.`,
    );
  }
  const sourceCreatedAt = info.birthtimeMs > 0 ? info.birthtime : info.mtime;
  return { path: realSource, bytes: info.size, createdAt: sourceCreatedAt.toISOString() };
}

function formatMiB(bytes: number): string {
  return String(bytes / (1024 * 1024));
}

function isCurrentWebUploadFile(candidate: string, root: string): boolean {
  if (!isWithin(candidate, root)) return false;
  const segments = relative(root, candidate).split(sep);
  return segments.length === 3 && segments[1] === "files" && segments.every(Boolean);
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function rawTranscriptText(response: TransSpeechTranscription, diarize: boolean): string {
  if (diarize && response.transcriptMarkdown?.trim()) return response.transcriptMarkdown.trim();
  if (response.segments.length > 0) {
    return response.segments.map((segment) => {
      const time = segment.start !== undefined ? `[${formatSeconds(segment.start)}] ` : "";
      const speaker = segment.speaker !== undefined ? `说话人 ${segment.speaker}: ` : "";
      return `${time}${speaker}${segment.text}`;
    }).join("\n");
  }
  return response.text.trim();
}

function formatTranscript(task: TranscriptionTaskInfo, response: TransSpeechTranscription, text: string): string {
  return [
    "# 逐字稿",
    "",
    "> 机器转写初稿，请人工校对。",
    "",
    `- 原始音频：${task.source.originalFileName}`,
    `- 语言：${response.language ?? task.parameters.language}`,
    `- 时长：${response.durationSeconds === undefined ? "未返回" : formatSeconds(response.durationSeconds)}`,
    `- 说话人分离：${task.parameters.diarize ? "已启用" : "未启用"}`,
    "",
    "---",
    "",
    text,
    "",
  ].join("\n");
}

function formatPolishedTranscript(task: TranscriptionTaskInfo, text: string): string {
  return [
    "# 逐字整理稿",
    "",
    "> 机器生成初稿，请人工审核后使用。",
    "",
    `- 原始音频：${task.source.originalFileName}`,
    "",
    "---",
    "",
    text.trim(),
    "",
  ].join("\n");
}

function formatMinutes(task: TranscriptionTaskInfo, minutes: string, actions: string[]): string {
  const output = [
    "# 会议纪要",
    "",
    "> 机器生成初稿，不能直接视为正式结论或正式发文材料，请人工审核。",
    "",
    `- 原始音频：${task.source.originalFileName}`,
    "",
    "---",
    "",
    minutes.trim(),
  ];
  if (task.parameters.actions) {
    output.push("", "## 待办事项", "");
    if (actions.length > 0) {
      output.push(...actions.map((action) => `- ${action}`));
    } else {
      output.push("未识别到明确待办事项。");
    }
  }
  output.push("");
  return output.join("\n");
}

async function sourceTextFromTranscript(store: TranscriptionTaskStore, taskDirectory: string): Promise<string> {
  const existing = await store.readArtifact(taskDirectory, TRANSCRIPTION_TRANSCRIPT_FILE);
  if (!existing) throw new TransSpeechClientError("invalid_response", "Transcript file is missing and cannot be retried.");
  const separator = "\n---\n";
  const index = existing.indexOf(separator);
  return (index >= 0 ? existing.slice(index + separator.length) : existing).trim();
}

function extractArtifactBody(value: string): string {
  const separator = "\n---\n";
  const index = value.indexOf(separator);
  return (index >= 0 ? value.slice(index + separator.length) : value).trim();
}

function failureStep(task: TranscriptionTaskInfo): "transcribe" | "polish" | "minutes" {
  if (task.status === "generating_minutes") return "minutes";
  if (task.status === "polishing") return "polish";
  if (!task.completedSteps.includes("transcribe")) return "transcribe";
  if (!task.completedSteps.includes("polish")) return "polish";
  return "minutes";
}

function addStep(steps: TranscriptionTaskInfo["completedSteps"], step: "transcribe" | "polish" | "minutes") {
  return steps.includes(step) ? steps : [...steps, step];
}

function isTerminal(status: TranscriptionTaskStatus): boolean {
  return status === "pending_review" || status === "partial" || status === "failed" || status === "cancelled";
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof TransSpeechClientError && error.kind === "aborted";
}

function toToolError(error: unknown, task: TranscriptionTaskInfo): PilotDeckToolRuntimeError {
  if (error instanceof PilotDeckToolRuntimeError) return error;
  if (error instanceof TransSpeechClientError) {
    const code = error.kind === "timeout" ? "tool_timeout"
      : error.kind === "invalid_request" ? "invalid_tool_input"
        : error.kind === "service_unavailable" ? "setup_required"
          : "tool_execution_failed";
    return new PilotDeckToolRuntimeError(code, `${error.message} Existing task results were kept.`, { taskId: task.id, status: task.status });
  }
  return new PilotDeckToolRuntimeError("tool_execution_failed", `${errorMessage(error)} Existing task results were kept.`, { taskId: task.id, status: task.status });
}

function errorCode(error: unknown): string {
  if (error instanceof TransSpeechClientError) return error.kind;
  if (error instanceof PilotDeckToolRuntimeError) return error.code;
  return "tool_execution_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfCancelled(taskDirectory: string, signal: AbortSignal): void {
  if (isCancelled(taskDirectory, signal)) {
    throw new TransSpeechClientError("aborted", "Recording task was cancelled.");
  }
}

function isCancelled(taskDirectory: string, signal: AbortSignal): boolean {
  return signal.aborted || cancellationRequests.has(taskDirectory);
}

function stepForArtifact(name: string): "transcribe" | "polish" | "minutes" {
  if (name === TRANSCRIPTION_TRANSCRIPT_FILE) return "transcribe";
  if (name === TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE) return "polish";
  return "minutes";
}

function removeArtifactReference(artifacts: TranscriptionTaskArtifacts, name: string): TranscriptionTaskArtifacts {
  if (name === TRANSCRIPTION_TRANSCRIPT_FILE) return { ...artifacts, transcript: undefined };
  if (name === TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE) return { ...artifacts, polishedTranscript: undefined };
  return { ...artifacts, minutes: undefined };
}

async function resolveStoredAudio(taskDirectory: string, task: TranscriptionTaskInfo): Promise<string> {
  const audioDirectory = resolve(taskDirectory, "原始音频");
  const path = resolve(taskDirectory, task.artifacts.originalAudio);
  if (!isWithin(path, audioDirectory)) {
    throw new PilotDeckToolRuntimeError("path_not_allowed", "Recording task source audio is outside its controlled task directory.");
  }
  const [realAudioDirectory, realPath] = await Promise.all([
    realpath(audioDirectory).catch(() => undefined),
    realpath(path).catch(() => undefined),
  ]);
  if (!realAudioDirectory || !realPath || !isWithin(realPath, realAudioDirectory)) {
    throw new PilotDeckToolRuntimeError("path_not_allowed", "Recording task source audio is outside its controlled task directory.");
  }
  const info = await stat(realPath);
  if (!info.isFile() || info.size !== task.source.bytes || await hashFile(realPath) !== task.source.sha256) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "Recording task source audio no longer matches the uploaded file.");
  }
  return realPath;
}

function formatSeconds(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function isWithin(candidate: string, root: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function taskDirectoryWorkspaceKey(taskDirectory: string): string {
  return resolve(taskDirectory, "..", "..");
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (!source) return undefined;
  const forward = () => target.abort(source.reason);
  if (source.aborted) {
    forward();
    return undefined;
  }
  source.addEventListener("abort", forward, { once: true });
  return () => source.removeEventListener("abort", forward);
}

class WorkspaceTaskLimiter {
  private readonly running = new Map<string, number>();
  private readonly waiting = new Map<string, Array<{ resolve: (release: () => void) => void; reject: (reason?: unknown) => void; signal?: AbortSignal }>>();

  async acquire(workspace: string, limit: number, signal: AbortSignal): Promise<() => void> {
    const active = this.running.get(workspace) ?? 0;
    if (active < limit) {
      this.running.set(workspace, active + 1);
      return this.releaseFor(workspace);
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry = { resolve, reject, signal };
      const queue = this.waiting.get(workspace) ?? [];
      queue.push(entry);
      this.waiting.set(workspace, queue);
      const cancel = () => {
        const current = this.waiting.get(workspace);
        if (!current) return;
        const index = current.indexOf(entry);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) this.waiting.delete(workspace);
        reject(new TransSpeechClientError("aborted", "Recording task was cancelled while waiting for capacity."));
      };
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  }

  private releaseFor(workspace: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.waiting.get(workspace) ?? [];
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next || next.signal?.aborted) continue;
        if (queue.length === 0) this.waiting.delete(workspace);
        next.resolve(this.releaseFor(workspace));
        return;
      }
      if (queue.length === 0) this.waiting.delete(workspace);
      const active = this.running.get(workspace) ?? 0;
      if (active <= 1) this.running.delete(workspace);
      else this.running.set(workspace, active - 1);
    };
  }
}

const workspaceLimiter = new WorkspaceTaskLimiter();
