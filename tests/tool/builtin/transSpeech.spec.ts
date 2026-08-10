import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PilotTransSpeechEnabledConfig } from "../../../src/pilot/config/types.js";
import { createTransSpeechTool } from "../../../src/tool/builtin/transSpeech.js";
import type { PilotDeckToolProgressEvent } from "../../../src/tool/protocol/types.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { TRANSCRIPTION_TASK_INFO_FILE, type TranscriptionTaskInfo } from "../../../src/transcription/types.js";

const config: PilotTransSpeechEnabledConfig = {
  enabled: true,
  baseUrl: "http://trans-speech:8090",
  language: "zh",
  asrProfile: "sensevoice",
  diarize: true,
  timeoutMs: 1_000,
  maxConcurrentTasks: 1,
  generate: { polish: true, minutes: true, actions: false },
};

test("trans_speech is registered only when its local service is configured", () => {
  assert.equal(createBuiltinRegistry({ transSpeech: false }).has("trans_speech"), false);
  assert.equal(createBuiltinRegistry({ transSpeech: { config } }).has("trans_speech"), true);
});

test("trans_speech creates result-file entries and reports progress for an uploaded recording", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-trans-speech-tool-"));
  try {
    const attachmentDirectory = join(workspace, ".tmp", "chat-attachments", "upload-1");
    const audioPath = join(attachmentDirectory, "meeting.wav");
    await mkdir(attachmentDirectory, { recursive: true });
    await writeFile(audioPath, "recording");
    const progress: string[] = [];
    const tool = createTransSpeechTool({ config, fetchImpl: completeFetch() });

    const result = await tool.execute({ action: "start", audio_path: audioPath }, {
      cwd: workspace,
      projectRoot: workspace,
      env: {},
      sessionId: "session",
      turnId: "turn",
      currentToolCallId: "call",
      progress: (event: PilotDeckToolProgressEvent) => progress.push(event.metadata?.status as string),
    } as any);

    assert.equal(result.data?.status, "pending_review");
    assert.equal(result.data?.artifacts.length, 3);
    assert.deepEqual(
      result.content.filter((item) => item.type === "file").map((item) => item.type === "file" ? item.description : ""),
      ["逐字稿", "逐字整理稿", "会议纪要"],
    );
    assert.deepEqual(progress, ["transcribing", "transcribed", "polishing", "generating_minutes", "pending_review"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("trans_speech never exposes an artifact path supplied by a modified task record", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-trans-speech-tool-"));
  try {
    const attachmentDirectory = join(workspace, ".tmp", "chat-attachments", "upload-1");
    const audioPath = join(attachmentDirectory, "meeting.wav");
    await mkdir(attachmentDirectory, { recursive: true });
    await writeFile(audioPath, "recording");
    const tool = createTransSpeechTool({ config, fetchImpl: completeFetch() });
    const context = {
      cwd: workspace,
      projectRoot: workspace,
      env: {},
      sessionId: "session",
      turnId: "turn",
      currentToolCallId: "call",
    } as any;
    const created = await tool.execute({ action: "start", audio_path: audioPath }, context);
    const taskDirectory = created.data?.taskDirectory ?? "";
    const task = JSON.parse(await readFile(join(taskDirectory, TRANSCRIPTION_TASK_INFO_FILE), "utf8")) as TranscriptionTaskInfo;
    task.artifacts.transcript = "../../../outside.md";
    await writeFile(join(taskDirectory, TRANSCRIPTION_TASK_INFO_FILE), `${JSON.stringify(task, null, 2)}\n`);

    const retried = await tool.execute({ action: "retry", task_id: task.id }, context);
    assert.equal(retried.data?.artifacts.find((item) => item.name === "逐字稿")?.path, await realpath(join(taskDirectory, "逐字稿.md")));
    assert.equal(retried.data?.artifacts.some((item) => item.path.includes("outside.md")), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("trans_speech validates action-specific input before execution", async () => {
  const tool = createTransSpeechTool({ config, fetchImpl: completeFetch() });
  assert.equal((await tool.validateInput?.({ action: "start" }, {} as any))?.ok, false);
  assert.equal((await tool.validateInput?.({ action: "retry" }, {} as any))?.ok, false);
  assert.equal((await tool.validateInput?.({ action: "cancel", task_id: "task" }, {} as any))?.ok, true);
});

function completeFetch(): typeof fetch {
  return async (url, init) => {
    if (String(url).endsWith("/health")) return jsonResponse({ status: "ok" });
    if (String(url).endsWith("/v1/transcribe")) return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
    const body = JSON.parse(String(init?.body));
    return body.polish ? jsonResponse({ text: "整理稿", actions: [] }) : jsonResponse({ text: "", minutes: "会议纪要", actions: [] });
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
