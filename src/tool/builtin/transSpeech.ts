import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { PermissionResult } from "../../permission/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { TranscriptionService, type TranscriptionServiceOptions } from "../../transcription/TranscriptionService.js";
import {
  TRANSCRIPTION_MINUTES_FILE,
  TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE,
  TRANSCRIPTION_TRANSCRIPT_FILE,
  type TranscriptionTaskInfo,
} from "../../transcription/types.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import type { PilotDeckToolValidationResult } from "../protocol/schema.js";

export type TransSpeechToolInput = {
  action: "start" | "retry" | "cancel";
  audio_path?: string;
  task_id?: string;
  force_duplicate?: boolean;
  include_actions?: boolean;
};

export type TransSpeechToolOutput = {
  taskId: string;
  status: TranscriptionTaskInfo["status"] | "duplicate";
  taskDirectory: string;
  artifacts: Array<{ name: string; path: string }>;
  duplicateTaskId?: string;
};

export type CreateTransSpeechToolOptions = Pick<TranscriptionServiceOptions, "config" | "maxFileSizeBytes" | "fetchImpl" | "now">;

export function createTransSpeechTool(
  options: CreateTransSpeechToolOptions,
): PilotDeckToolDefinition<TransSpeechToolInput, TransSpeechToolOutput> {
  return {
    name: "trans_speech",
    aliases: ["TransSpeech"],
    title: "录音整理",
    description: `Processes an uploaded .wav, .mp3, .m4a, or .flac file through the configured local Trans-Speech service.
- Use action "start" for an audio_path from the current chat attachment.
- Use action "retry" only for an existing task_id whose failed step needs another attempt.
- Use action "cancel" when the user asks to stop a recording task. It performs a soft cancellation: PilotDeck stops waiting and will not write later results, but Trans-Speech may continue its already-started computation.
- Setting include_actions=true also creates meeting minutes because action items are included at the end of the meeting-minutes file.
- Each file is a separate task. Never combine recordings.
- The tool saves transcript, polished transcript, and meeting minutes in the current workspace. Return the file paths instead of pasting long transcripts into chat.`,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["start", "retry", "cancel"] },
        audio_path: { type: "string", description: "Exact path of a Web audio attachment uploaded in this chat. Required for start." },
        task_id: { type: "string", description: "Recording task id. Required for retry and cancel." },
        force_duplicate: { type: "boolean", description: "Set true only after the user explicitly chooses to create another task for a duplicate audio file." },
        include_actions: { type: "boolean", description: "Generate action items only when the user explicitly requests them." },
      },
    },
    outputSchema: {
      type: "object",
      required: ["taskId", "status", "taskDirectory", "artifacts"],
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        status: { type: "string" },
        taskDirectory: { type: "string" },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "path"],
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              path: { type: "string" },
            },
          },
        },
        duplicateTaskId: { type: "string" },
      },
    },
    maxResultBytes: 20_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isOpenWorld: () => false,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "allow",
      reason: {
        type: "tool",
        toolName: "trans_speech",
        message: "Trans-Speech is a configured local service for user-uploaded audio.",
      },
    }),
    validateInput: async (input) => validateTransSpeechInput(input),
    execute: async (input, context) => executeTransSpeech(options, input, context),
  };
}

function validateTransSpeechInput(input: TransSpeechToolInput): PilotDeckToolValidationResult {
  if (input.action === "start" && !input.audio_path?.trim()) {
    return { ok: false as const, issues: [{ path: "audio_path", code: "invalid_schema", message: "audio_path is required when action is start." }] };
  }
  if ((input.action === "retry" || input.action === "cancel") && !input.task_id?.trim()) {
    return { ok: false as const, issues: [{ path: "task_id", code: "invalid_schema", message: `task_id is required when action is ${input.action}.` }] };
  }
  return { ok: true as const, input };
}

async function executeTransSpeech(
  options: CreateTransSpeechToolOptions,
  input: TransSpeechToolInput,
  context: PilotDeckToolRuntimeContext,
): Promise<PilotDeckToolExecutionOutput<TransSpeechToolOutput>> {
  const service = new TranscriptionService(options);
  const onProgress = (message: string, status: TranscriptionTaskInfo["status"]) => {
    try {
      context.progress?.({
        type: "tool_progress",
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: context.currentToolCallId ?? "",
        toolName: "trans_speech",
        message,
        metadata: { status },
        createdAt: (context.now?.() ?? new Date()).toISOString(),
      });
    } catch {
      // Tool progress delivery must never affect transcription correctness.
    }
  };

  const result = input.action === "start"
    ? await service.start(context.cwd, {
      audioPath: input.audio_path ?? "",
      forceDuplicate: input.force_duplicate,
      includeActions: input.include_actions,
      signal: context.abortSignal,
      onProgress,
    })
    : input.action === "retry"
      ? await service.retry(context.cwd, input.task_id ?? "", { signal: context.abortSignal, onProgress })
      : await service.cancel(context.cwd, input.task_id ?? "");

  const data = await toToolOutput(result.task, result.taskDirectory, result.duplicateTaskId);
  if (result.duplicateTaskId) {
    return {
      content: [{ type: "text", text: `A matching recording task already exists: ${result.duplicateTaskId}. Ask the user whether to view the existing task or create a new one with force_duplicate=true.` }],
      data,
    };
  }
  return {
    content: [
      { type: "text", text: taskSummary(data) },
      ...data.artifacts.map((artifact) => ({ type: "file" as const, path: artifact.path, mimeType: "text/markdown", description: artifact.name })),
    ],
    data,
  };
}

async function toToolOutput(task: TranscriptionTaskInfo, taskDirectory: string, duplicateTaskId?: string): Promise<TransSpeechToolOutput> {
  const artifacts = (await Promise.all([
    task.artifacts.transcript && safeArtifact(taskDirectory, TRANSCRIPTION_TRANSCRIPT_FILE, "逐字稿"),
    task.artifacts.polishedTranscript && safeArtifact(taskDirectory, TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE, "逐字整理稿"),
    task.artifacts.minutes && safeArtifact(taskDirectory, TRANSCRIPTION_MINUTES_FILE, "会议纪要"),
  ])).filter((item): item is { name: string; path: string } => Boolean(item));
  return {
    taskId: task.id,
    status: duplicateTaskId ? "duplicate" : task.status,
    taskDirectory,
    artifacts,
    ...(duplicateTaskId ? { duplicateTaskId } : {}),
  };
}

async function safeArtifact(taskDirectory: string, name: string, displayName: string): Promise<{ name: string; path: string } | undefined> {
  const root = await realpath(taskDirectory);
  const path = resolve(root, name);
  if (!isWithin(path, root)) {
    throw new PilotDeckToolRuntimeError("path_not_allowed", "Recording task artifact is outside its controlled task directory.");
  }
  let realPath: string;
  try {
    realPath = await realpath(path);
    const info = await stat(realPath);
    if (!info.isFile()) return undefined;
  } catch {
    return undefined;
  }
  if (!isWithin(realPath, root)) {
    throw new PilotDeckToolRuntimeError("path_not_allowed", "Recording task artifact is outside its controlled task directory.");
  }
  return { name: displayName, path: realPath };
}

function isWithin(candidate: string, root: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function taskSummary(output: TransSpeechToolOutput): string {
  const files = output.artifacts.length > 0 ? output.artifacts.map((artifact) => artifact.path).join("\n") : "No result files were generated.";
  return `Recording task ${output.taskId} is ${output.status}.\n${files}`;
}
