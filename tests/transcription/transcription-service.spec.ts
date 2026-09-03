import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { PilotTransSpeechEnabledConfig } from "../../src/pilot/config/types.js";
import { TranscriptionService } from "../../src/transcription/TranscriptionService.js";
import {
  TRANSCRIPTION_MINUTES_FILE,
  TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE,
  TRANSCRIPTION_PROCESSING_RECORD_FILE,
  TRANSCRIPTION_TASK_DIRECTORY,
  TRANSCRIPTION_TASK_INFO_FILE,
  TRANSCRIPTION_TRANSCRIPT_FILE,
  type TranscriptionTaskInfo,
} from "../../src/transcription/types.js";

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

test("transcription saves three artifacts in an isolated task directory", async () => {
  const fixture = await createFixture();
  try {
    const calls: string[] = [];
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url, init) => {
      calls.push(`${url} ${init?.method ?? "GET"}`);
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/v1/transcribe")) {
        return jsonResponse({
          text: "原始转写",
          transcript_md: "[00:00] 说话人 A: 原始转写",
          language: "zh",
          duration: 61,
          segments: [{ start: 0, end: 2, text: "原始转写", speaker: "A" }],
        });
      }
      const body = JSON.parse(String(init?.body));
      return body.polish
        ? jsonResponse({ text: "整理后的逐字稿", actions: [] })
        : jsonResponse({ text: "", minutes: "会议纪要正文", actions: [] });
    }) });

    const result = await service.start(fixture.workspace, { audioPath: fixture.audioPath });
    assert.equal(result.task.status, "pending_review");
    assert.deepEqual(result.task.completedSteps, ["transcribe", "polish", "minutes"]);
    assert.equal(result.task.source.durationSeconds, 61);
    assert.equal(result.task.source.bytes, "recording bytes".length);
    assert.notEqual(result.task.source.sourceCreatedAt, "");
    await assertFileContains(join(result.taskDirectory, TRANSCRIPTION_TRANSCRIPT_FILE), "机器转写初稿");
    await assertFileContains(join(result.taskDirectory, TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE), "整理后的逐字稿");
    await assertFileContains(join(result.taskDirectory, TRANSCRIPTION_MINUTES_FILE), "会议纪要正文");
    assert.equal(calls.filter((call) => call.endsWith("/v1/enhance POST")).length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("a non-diarized transcription uses plain text instead of transcript markdown", async () => {
  const fixture = await createFixture();
  try {
    const service = new TranscriptionService({
      config: { ...config, diarize: false, generate: { polish: false, minutes: false, actions: false } },
      fetchImpl: createFetch((url) => {
        if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
        return jsonResponse({
          text: "普通转写文本",
          transcript_md: "**SPEAKER_00**\n\n不应写入逐字稿",
          segments: [],
        });
      }),
    });

    const result = await service.start(fixture.workspace, { audioPath: fixture.audioPath });
    const transcript = await readFile(join(result.taskDirectory, TRANSCRIPTION_TRANSCRIPT_FILE), "utf8");
    assert.match(transcript, /普通转写文本/);
    assert.doesNotMatch(transcript, /不应写入逐字稿/);
  } finally {
    await fixture.cleanup();
  }
});

test("retry does not overwrite an artifact edited by a reviewer", async () => {
  const fixture = await createFixture();
  try {
    const service = new TranscriptionService({ config, fetchImpl: completeFetch() });
    const result = await service.start(fixture.workspace, { audioPath: fixture.audioPath });
    const transcriptPath = join(result.taskDirectory, TRANSCRIPTION_TRANSCRIPT_FILE);
    await writeFile(transcriptPath, "# 逐字稿\n\n人工修订后的内容\n");

    const retried = await service.retry(fixture.workspace, result.task.id);
    assert.equal(retried.task.status, "pending_review");
    assert.equal(await readFile(transcriptPath, "utf8"), "# 逐字稿\n\n人工修订后的内容\n");
  } finally {
    await fixture.cleanup();
  }
});

test("an enhancement failure keeps the transcript and retry skips transcription", async () => {
  const fixture = await createFixture();
  try {
    let enhanceAvailable = false;
    let transcriptionCalls = 0;
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/v1/transcribe")) {
        transcriptionCalls += 1;
        return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
      }
      if (!enhanceAvailable) return jsonResponse({ error: "model unavailable" }, 503);
      const body = JSON.parse(String(init?.body));
      return body.polish ? jsonResponse({ text: "整理稿", actions: [] }) : jsonResponse({ text: "", minutes: "纪要", actions: [] });
    }) });

    await assert.rejects(service.start(fixture.workspace, { audioPath: fixture.audioPath }), { code: "setup_required" });
    const taskId = await onlyTaskId(fixture.workspace);
    const partial = await readTask(fixture.workspace, taskId);
    assert.equal(partial.status, "partial");
    await assertFileContains(join(fixture.workspace, TRANSCRIPTION_TASK_DIRECTORY, taskId, TRANSCRIPTION_TRANSCRIPT_FILE), "原始转写");

    enhanceAvailable = true;
    const retried = await service.retry(fixture.workspace, taskId);
    assert.equal(retried.task.status, "pending_review");
    assert.equal(transcriptionCalls, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a meeting-minutes failure preserves earlier results and retry runs only the failed step", async () => {
  const fixture = await createFixture();
  try {
    let minutesAvailable = false;
    let transcriptionCalls = 0;
    let polishCalls = 0;
    let minutesCalls = 0;
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/v1/transcribe")) {
        transcriptionCalls += 1;
        return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
      }
      const body = JSON.parse(String(init?.body));
      if (body.polish) {
        polishCalls += 1;
        return jsonResponse({ text: "整理稿", actions: [] });
      }
      minutesCalls += 1;
      return minutesAvailable ? jsonResponse({ text: "", minutes: "纪要", actions: [] }) : jsonResponse({ error: "model unavailable" }, 503);
    }) });

    await assert.rejects(service.start(fixture.workspace, { audioPath: fixture.audioPath }), { code: "setup_required" });
    const taskId = await onlyTaskId(fixture.workspace);
    const partial = await readTask(fixture.workspace, taskId);
    assert.equal(partial.status, "partial");
    assert.equal(partial.failure?.step, "minutes");
    await assertFileContains(join(fixture.workspace, TRANSCRIPTION_TASK_DIRECTORY, taskId, TRANSCRIPTION_POLISHED_TRANSCRIPT_FILE), "整理稿");

    minutesAvailable = true;
    const retried = await service.retry(fixture.workspace, taskId);
    assert.equal(retried.task.status, "pending_review");
    assert.equal(transcriptionCalls, 1);
    assert.equal(polishCalls, 1);
    assert.equal(minutesCalls, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("meeting-minutes requests explicitly disable implicit polishing", async () => {
  const fixture = await createFixture();
  try {
    let minutesRequest: Record<string, unknown> | undefined;
    const service = new TranscriptionService({
      config: { ...config, generate: { polish: false, minutes: true, actions: false } },
      fetchImpl: createFetch((url, init) => {
        if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
        if (url.endsWith("/v1/transcribe")) return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
        minutesRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ text: "", minutes: "纪要", actions: [] });
      }),
    });

    await service.start(fixture.workspace, { audioPath: fixture.audioPath });
    assert.equal(minutesRequest?.polish, false);
    assert.equal(minutesRequest?.minutes, true);
    assert.equal(minutesRequest?.actions, false);
  } finally {
    await fixture.cleanup();
  }
});

test("retry keeps the task's original output choices when the current configuration changes", async () => {
  const fixture = await createFixture();
  try {
    let minutesAvailable = false;
    let polishCalls = 0;
    let minutesCalls = 0;
    const fetchImpl = createFetch((url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/v1/transcribe")) return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
      const body = JSON.parse(String(init?.body));
      if (body.polish) {
        polishCalls += 1;
        return jsonResponse({ text: "不应生成整理稿", actions: [] });
      }
      minutesCalls += 1;
      return minutesAvailable ? jsonResponse({ text: "", minutes: "纪要", actions: [] }) : jsonResponse({ error: "model unavailable" }, 503);
    });
    const initial = new TranscriptionService({
      config: { ...config, generate: { polish: false, minutes: true, actions: false } },
      fetchImpl,
    });

    await assert.rejects(initial.start(fixture.workspace, { audioPath: fixture.audioPath }), { code: "setup_required" });
    const taskId = await onlyTaskId(fixture.workspace);
    minutesAvailable = true;
    const retried = await new TranscriptionService({
      config: { ...config, generate: { polish: true, minutes: false, actions: false } },
      fetchImpl,
    }).retry(fixture.workspace, taskId);

    assert.equal(retried.task.status, "pending_review");
    assert.equal(polishCalls, 0);
    assert.equal(minutesCalls, 2);
    await assertFileContains(join(retried.taskDirectory, TRANSCRIPTION_MINUTES_FILE), "纪要");
  } finally {
    await fixture.cleanup();
  }
});

test("a cancelled task records cancelled state and never writes a transcript", async () => {
  const fixture = await createFixture();
  try {
    let transcriptionStarted: (() => void) | undefined;
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/v1/transcribe")) {
        return new Promise<Response>((_resolve, reject) => {
          transcriptionStarted = () => reject(init?.signal?.reason ?? new Error("aborted"));
          init?.signal?.addEventListener("abort", transcriptionStarted, { once: true });
        });
      }
      throw new Error("enhance should not run after cancellation");
    }) });
    const controller = new AbortController();
    const pending = service.start(fixture.workspace, { audioPath: fixture.audioPath, signal: controller.signal });
    await waitFor(() => transcriptionStarted !== undefined);
    controller.abort(new Error("user stopped"));
    await assert.rejects(pending, { code: "tool_aborted" });

    const taskId = await onlyTaskId(fixture.workspace);
    const cancelled = await readTask(fixture.workspace, taskId);
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(readFile(join(fixture.workspace, TRANSCRIPTION_TASK_DIRECTORY, taskId, TRANSCRIPTION_TRANSCRIPT_FILE), "utf8"));
  } finally {
    await fixture.cleanup();
  }
});

test("cancelling while a transcription result is being committed removes the late transcript", async () => {
  const fixture = await createFixture();
  try {
    let taskId = "";
    let resolveTranscription: ((response: Response) => void) | undefined;
    let cancelPromise: Promise<unknown> | undefined;
    let nowCalls = 0;
    let service!: TranscriptionService;
    service = new TranscriptionService({
      config: { ...config, generate: { polish: false, minutes: false, actions: false } },
      now: () => {
        nowCalls += 1;
        if (nowCalls === 3 && taskId && !cancelPromise) {
          cancelPromise = service.cancel(fixture.workspace, taskId);
        }
        return new Date("2026-08-05T00:00:00.000Z");
      },
      fetchImpl: createFetch((url) => {
        if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
        if (url.endsWith("/v1/transcribe")) {
          return new Promise<Response>((resolve) => {
            resolveTranscription = resolve;
          });
        }
        throw new Error("enhance should not run");
      }),
    });

    const pending = service.start(fixture.workspace, {
      audioPath: fixture.audioPath,
      onProgress: (message) => {
        if (message === "Calling Trans-Speech transcription.") {
          void onlyTaskId(fixture.workspace).then((id) => {
            taskId = id;
          });
        }
      },
    });
    await waitFor(() => taskId !== "" && resolveTranscription !== undefined);
    resolveTranscription?.(jsonResponse({ text: "晚到的转写", duration: 1, segments: [] }));

    await assert.rejects(pending, { code: "tool_aborted" });
    await cancelPromise;
    const cancelled = await readTask(fixture.workspace, taskId);
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(readFile(join(fixture.workspace, TRANSCRIPTION_TASK_DIRECTORY, taskId, TRANSCRIPTION_TRANSCRIPT_FILE), "utf8"));
  } finally {
    await fixture.cleanup();
  }
});

test("cancelling an active task aborts local waiting and keeps the final task state cancelled", async () => {
  const fixture = await createFixture();
  try {
    let transcriptionStarted: (() => void) | undefined;
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      return new Promise<Response>((_resolve, reject) => {
        transcriptionStarted = () => reject(init?.signal?.reason ?? new Error("aborted"));
        init?.signal?.addEventListener("abort", transcriptionStarted, { once: true });
      });
    }) });

    const pending = service.start(fixture.workspace, { audioPath: fixture.audioPath });
    const observed = pending.then(
      () => assert.fail("Expected cancelled transcription to reject."),
      (error) => error,
    );
    await waitFor(() => transcriptionStarted !== undefined);
    const taskId = await onlyTaskId(fixture.workspace);
    const cancelled = await service.cancel(fixture.workspace, taskId);
    assert.equal(cancelled.task.status, "cancelled");
    assert.equal((await observed as { code?: string }).code, "tool_aborted");
    assert.equal((await readTask(fixture.workspace, taskId)).status, "cancelled");
  } finally {
    await fixture.cleanup();
  }
});

test("a rejected transcription request records a failed task and exposes the request error", async () => {
  const fixture = await createFixture();
  try {
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      return jsonResponse({ error: "invalid audio" }, 400);
    }) });

    await assert.rejects(service.start(fixture.workspace, { audioPath: fixture.audioPath }), { code: "invalid_tool_input" });
    const failed = await readTask(fixture.workspace, await onlyTaskId(fixture.workspace));
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure?.step, "transcribe");
    assert.equal(failed.failure?.code, "invalid_request");
  } finally {
    await fixture.cleanup();
  }
});

test("a health response that is not ready prevents transcription from starting", async () => {
  const fixture = await createFixture();
  try {
    let transcriptionCalls = 0;
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "loading" });
      transcriptionCalls += 1;
      return jsonResponse({ text: "unexpected" });
    }) });

    await assert.rejects(service.start(fixture.workspace, { audioPath: fixture.audioPath }), { code: "setup_required" });
    assert.equal(transcriptionCalls, 0);
    const failed = await readTask(fixture.workspace, await onlyTaskId(fixture.workspace));
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure?.code, "service_unavailable");
  } finally {
    await fixture.cleanup();
  }
});

test("matching audio is reported as a duplicate until the user forces a new task", async () => {
  const fixture = await createFixture();
  try {
    const service = new TranscriptionService({ config, fetchImpl: completeFetch() });
    const first = await service.start(fixture.workspace, { audioPath: fixture.audioPath });
    const duplicate = await service.start(fixture.workspace, { audioPath: fixture.audioPath });
    assert.equal(duplicate.duplicateTaskId, first.task.id);
    const forced = await service.start(fixture.workspace, { audioPath: fixture.audioPath, forceDuplicate: true });
    assert.notEqual(forced.task.id, first.task.id);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent matching recordings create one task and return one duplicate", async () => {
  const fixture = await createFixture();
  try {
    let transcriptionCalls = 0;
    const fetchImpl = createFetch((url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/v1/transcribe")) {
        transcriptionCalls += 1;
        return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
      }
      const body = JSON.parse(String(init?.body));
      return body.polish ? jsonResponse({ text: "整理稿", actions: [] }) : jsonResponse({ text: "", minutes: "纪要", actions: [] });
    });
    const firstService = new TranscriptionService({ config, fetchImpl });
    const secondService = new TranscriptionService({ config, fetchImpl });

    const results = await Promise.all([
      firstService.start(fixture.workspace, { audioPath: fixture.audioPath }),
      secondService.start(fixture.workspace, { audioPath: fixture.audioPath }),
    ]);
    const created = results.filter((result) => !result.duplicateTaskId);
    const duplicates = results.filter((result) => result.duplicateTaskId);
    assert.equal(created.length, 1);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]?.duplicateTaskId, created[0]?.task.id);
    assert.equal(transcriptionCalls, 1);
    assert.equal((await readdir(join(fixture.workspace, TRANSCRIPTION_TASK_DIRECTORY))).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("retry refuses a task record whose source path escapes the controlled audio directory", async () => {
  const fixture = await createFixture();
  try {
    let transcriptionCalls = 0;
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      transcriptionCalls += 1;
      return jsonResponse({ error: "invalid audio" }, 400);
    }) });
    await assert.rejects(service.start(fixture.workspace, { audioPath: fixture.audioPath }), { code: "invalid_tool_input" });
    const taskId = await onlyTaskId(fixture.workspace);
    const task = await readTask(fixture.workspace, taskId);
    task.artifacts.originalAudio = "../../outside.wav";
    await writeFile(join(fixture.workspace, TRANSCRIPTION_TASK_DIRECTORY, taskId, TRANSCRIPTION_TASK_INFO_FILE), `${JSON.stringify(task, null, 2)}\n`);
    transcriptionCalls = 0;

    await assert.rejects(service.retry(fixture.workspace, taskId), { code: "path_not_allowed" });
    assert.equal(transcriptionCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("multiple uploaded files with the same name produce separate task directories", async () => {
  const fixture = await createFixture();
  try {
    const secondUploadDirectory = join(fixture.workspace, ".tmp", "chat-attachments", "upload-2");
    const secondAudio = join(secondUploadDirectory, "meeting.m4a");
    await mkdir(secondUploadDirectory, { recursive: true });
    await writeFile(secondAudio, "different recording bytes");
    const service = new TranscriptionService({ config, fetchImpl: completeFetch() });

    const first = await service.start(fixture.workspace, { audioPath: fixture.audioPath });
    const second = await service.start(fixture.workspace, { audioPath: secondAudio });
    assert.notEqual(first.taskDirectory, second.taskDirectory);
    await assertFileContains(join(first.taskDirectory, "原始音频", "meeting.m4a"), "recording bytes");
    await assertFileContains(join(second.taskDirectory, "原始音频", "meeting.m4a"), "different recording bytes");
  } finally {
    await fixture.cleanup();
  }
});

test("explicit action-item requests override the default no-actions setting", async () => {
  const fixture = await createFixture();
  try {
    let minutesRequest: Record<string, unknown> | undefined;
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/v1/transcribe")) return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.minutes) minutesRequest = body;
      return body.polish ? jsonResponse({ text: "整理稿", actions: [] }) : jsonResponse({ text: "", minutes: "纪要", actions: ["确认负责人"] });
    }) });

    const result = await service.start(fixture.workspace, { audioPath: fixture.audioPath, includeActions: true });
    assert.equal(result.task.parameters.actions, true);
    assert.equal(minutesRequest?.actions, true);
    await assertFileContains(join(result.taskDirectory, TRANSCRIPTION_MINUTES_FILE), "确认负责人");
    await assertFileContains(join(result.taskDirectory, TRANSCRIPTION_PROCESSING_RECORD_FILE), "待办事项提取结果：已识别 1 项。");
  } finally {
    await fixture.cleanup();
  }
});

test("default action-item generation records an empty result without inventing action items", async () => {
  const fixture = await createFixture();
  try {
    let minutesRequest: Record<string, unknown> | undefined;
    const service = new TranscriptionService({
      config: { ...config, generate: { polish: false, minutes: true, actions: true } },
      fetchImpl: createFetch((url, init) => {
        if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
        if (url.endsWith("/v1/transcribe")) return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
        minutesRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ text: "", minutes: "会议纪要", actions: [] });
      }),
    });

    const result = await service.start(fixture.workspace, { audioPath: fixture.audioPath });
    assert.equal(result.task.parameters.actions, true);
    assert.equal(minutesRequest?.actions, true);
    await assertFileContains(join(result.taskDirectory, TRANSCRIPTION_MINUTES_FILE), "## 待办事项");
    await assertFileContains(join(result.taskDirectory, TRANSCRIPTION_MINUTES_FILE), "未识别到明确待办事项。");
    await assertFileContains(join(result.taskDirectory, TRANSCRIPTION_PROCESSING_RECORD_FILE), "待办事项提取结果：未识别到明确待办事项。");
  } finally {
    await fixture.cleanup();
  }
});

test("an explicit action-item request creates meeting minutes when minutes are disabled by default", async () => {
  const fixture = await createFixture();
  try {
    let minutesRequest: Record<string, unknown> | undefined;
    const service = new TranscriptionService({
      config: { ...config, generate: { polish: false, minutes: false, actions: false } },
      fetchImpl: createFetch((url, init) => {
        if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
        if (url.endsWith("/v1/transcribe")) return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
        minutesRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ text: "", minutes: "会议纪要", actions: ["确认负责人"] });
      }),
    });

    const result = await service.start(fixture.workspace, { audioPath: fixture.audioPath, includeActions: true });
    assert.equal(result.task.parameters.minutes, true);
    assert.equal(result.task.parameters.actions, true);
    assert.equal(minutesRequest?.minutes, true);
    assert.equal(minutesRequest?.actions, true);
    await assertFileContains(join(result.taskDirectory, TRANSCRIPTION_MINUTES_FILE), "确认负责人");
  } finally {
    await fixture.cleanup();
  }
});

test("tasks from the same workspace wait for configured capacity", async () => {
  const fixture = await createFixture();
  try {
    const secondAudio = join(fixture.uploadDirectory, "second.wav");
    await writeFile(secondAudio, "second recording");
    let activeTranscriptions = 0;
    let maximumActive = 0;
    const gates: Array<() => void> = [];
    const service = new TranscriptionService({ config, fetchImpl: createFetch((url, init) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/v1/transcribe")) {
        activeTranscriptions += 1;
        maximumActive = Math.max(maximumActive, activeTranscriptions);
        return new Promise<Response>((resolve) => gates.push(() => {
          activeTranscriptions -= 1;
          resolve(jsonResponse({ text: "原始转写", duration: 1, segments: [] }));
        }));
      }
      const body = JSON.parse(String(init?.body));
      return body.polish ? jsonResponse({ text: "整理稿", actions: [] }) : jsonResponse({ text: "", minutes: "纪要", actions: [] });
    }) });

    const first = service.start(fixture.workspace, { audioPath: fixture.audioPath });
    await waitFor(() => gates.length === 1);
    const second = service.start(fixture.workspace, { audioPath: secondAudio });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(maximumActive, 1);
    gates.shift()?.();
    await waitFor(() => gates.length === 1);
    gates.shift()?.();
    await Promise.all([first, second]);
    assert.equal(maximumActive, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects paths outside Web uploads, unsupported formats, and files above the configured limit", async () => {
  const fixture = await createFixture();
  try {
    const maxFileSizeBytes = 64;
    const service = new TranscriptionService({ config, maxFileSizeBytes, fetchImpl: completeFetch() });
    const outsideAudio = join(fixture.workspace, "outside.wav");
    const unmanagedCurrentUpload = join(fixture.workspace, ".tmp", "chat-uploads", "unmanaged.wav");
    const unsupported = join(fixture.uploadDirectory, "meeting.txt");
    const empty = join(fixture.uploadDirectory, "empty.mp3");
    const tooLarge = join(fixture.uploadDirectory, "too-large.mp3");
    await writeFile(outsideAudio, "outside");
    await mkdir(join(fixture.workspace, ".tmp", "chat-uploads"), { recursive: true });
    await writeFile(unmanagedCurrentUpload, "unmanaged");
    await writeFile(unsupported, "not audio");
    await writeFile(empty, "");
    await writeFile(tooLarge, Buffer.alloc(maxFileSizeBytes + 1));

    await assert.rejects(service.start(fixture.workspace, { audioPath: outsideAudio }), { code: "path_not_allowed" });
    await assert.rejects(service.start(fixture.workspace, { audioPath: unmanagedCurrentUpload }), { code: "path_not_allowed" });
    await assert.rejects(service.start(fixture.workspace, { audioPath: unsupported }), { code: "invalid_tool_input" });
    await assert.rejects(service.start(fixture.workspace, { audioPath: empty }), { code: "invalid_tool_input" });
    await assert.rejects(service.start(fixture.workspace, { audioPath: tooLarge }), { code: "invalid_tool_input" });
    await assert.rejects(service.start(fixture.workspace, { audioPath: join(fixture.uploadDirectory, "missing.mp3") }), { code: "file_not_found" });
  } finally {
    await fixture.cleanup();
  }
});

test("accepts all supported audio extensions and the configured size boundary", async () => {
  const fixture = await createFixture();
  try {
    const maxFileSizeBytes = 64;
    const service = new TranscriptionService({
      config: { ...config, generate: { polish: false, minutes: false, actions: false } },
      maxFileSizeBytes,
      fetchImpl: completeFetch(),
    });
    for (const extension of [".WAV", ".MP3", ".M4A", ".FLAC"]) {
      const audioPath = join(fixture.uploadDirectory, `recording-${extension.slice(1)}${extension}`);
      await writeFile(audioPath, `recording ${extension}`);
      const result = await service.start(fixture.workspace, { audioPath, forceDuplicate: true });
      assert.equal(result.task.status, "pending_review");
    }

    const atLimit = join(fixture.uploadDirectory, "at-limit.mp3");
    await writeFile(atLimit, Buffer.alloc(maxFileSizeBytes, 1));
    const result = await service.start(fixture.workspace, { audioPath: atLimit, forceDuplicate: true });
    assert.equal(result.task.source.bytes, maxFileSizeBytes);
  } finally {
    await fixture.cleanup();
  }
});

test("accepts both current and legacy Web upload directories", async () => {
  const fixture = await createFixture();
  try {
    const currentUploadDirectory = join(fixture.workspace, ".tmp", "chat-uploads", "upload-2", "files");
    const currentAudio = join(currentUploadDirectory, "recording.flac");
    await mkdir(currentUploadDirectory, { recursive: true });
    await writeFile(currentAudio, "current Web upload");

    const service = new TranscriptionService({
      config: { ...config, generate: { polish: false, minutes: false, actions: false } },
      fetchImpl: completeFetch(),
    });
    const legacy = await service.start(fixture.workspace, { audioPath: fixture.audioPath });
    const current = await service.start(fixture.workspace, { audioPath: currentAudio });

    assert.equal(legacy.task.status, "pending_review");
    assert.equal(current.task.status, "pending_review");
  } finally {
    await fixture.cleanup();
  }
});

test("converts a Trans-Speech timeout into a failed task with a retryable timeout error", async () => {
  const fixture = await createFixture();
  try {
    const service = new TranscriptionService({
      config: { ...config, timeoutMs: 1 },
      fetchImpl: createFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })),
    });

    await assert.rejects(service.start(fixture.workspace, { audioPath: fixture.audioPath }), { code: "tool_timeout" });
    const failed = await readTask(fixture.workspace, await onlyTaskId(fixture.workspace));
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure?.code, "timeout");
  } finally {
    await fixture.cleanup();
  }
});

test("does not write the configured service address into task failure records", async () => {
  const fixture = await createFixture();
  try {
    const service = new TranscriptionService({
      config,
      fetchImpl: createFetch(() => {
        throw new Error("connect ECONNREFUSED http://trans-speech:8090");
      }),
    });

    await assert.rejects(service.start(fixture.workspace, { audioPath: fixture.audioPath }), (error: unknown) => {
      assert.doesNotMatch(error instanceof Error ? error.message : String(error), /trans-speech:8090/);
      return true;
    });
    const failed = await readTask(fixture.workspace, await onlyTaskId(fixture.workspace));
    assert.doesNotMatch(failed.failure?.message ?? "", /trans-speech:8090/);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-transcription-"));
  const uploadDirectory = join(workspace, ".tmp", "chat-attachments", "upload-1");
  await mkdir(uploadDirectory, { recursive: true });
  const audioPath = join(uploadDirectory, "meeting.m4a");
  await writeFile(audioPath, "recording bytes");
  return {
    workspace,
    uploadDirectory,
    audioPath,
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

function createFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => handler(String(input), init);
}

function completeFetch(): typeof fetch {
  return createFetch((url, init) => {
    if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
    if (url.endsWith("/v1/transcribe")) return jsonResponse({ text: "原始转写", duration: 1, segments: [] });
    const body = JSON.parse(String(init?.body));
    return body.polish ? jsonResponse({ text: "整理稿", actions: [] }) : jsonResponse({ text: "", minutes: "纪要", actions: [] });
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function onlyTaskId(workspace: string): Promise<string> {
  const taskIds = await readdir(join(workspace, TRANSCRIPTION_TASK_DIRECTORY));
  assert.equal(taskIds.length, 1);
  return taskIds[0] ?? "";
}

async function readTask(workspace: string, taskId: string): Promise<TranscriptionTaskInfo> {
  return JSON.parse(await readFile(join(workspace, TRANSCRIPTION_TASK_DIRECTORY, taskId, TRANSCRIPTION_TASK_INFO_FILE), "utf8")) as TranscriptionTaskInfo;
}

async function assertFileContains(path: string, expected: string): Promise<void> {
  assert.match(await readFile(path, "utf8"), new RegExp(expected));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
