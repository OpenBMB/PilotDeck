import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlTranscriptWriter } from "../../src/session/transcript/JsonlTranscriptWriter.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import { AgentSession } from "../../src/agent/session/AgentSession.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import type { LifecycleRuntime } from "../../src/lifecycle/index.js";
import { SessionMetadataStore } from "../../src/session/metadata/SessionMetadataStore.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

const NOW = "2026-08-16T09:00:00.000Z";

function result(sessionId: string): AgentTurnResult {
  return {
    type: "success",
    sessionId,
    turnId: "turn-1",
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: NOW,
    completedAt: NOW,
  };
}

async function runWithResult(throws: boolean): Promise<InMemoryTranscriptWriter> {
  const sessionId = throws ? "error-session" : "success-session";
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({
    transcript,
    sessionId,
    now: () => new Date(NOW),
  });
  await metadataStore.saveAiTitle("Pinned at transcript tail", "title-turn");

  const successfulResult = result(sessionId);
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      if (throws) throw new Error("model unavailable");
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: successfulResult };
      return { result: successfulResult, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
    transcript,
    undefined,
    () => new Date(NOW),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    { metadataStore, autoGenerateSessionTitle: false },
  );

  for await (const _event of runner.run({
    sessionId,
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: "Create a briefing" },
  })) {
    // Exhaust the turn so the final metadata snapshot is persisted.
  }
  return transcript;
}

test("TurnRunner appends session metadata after successful and failed accepted turns", async () => {
  for (const throws of [false, true]) {
    const transcript = await runWithResult(throws);
    const lastEntry = transcript.entries.at(-1);
    assert.equal(lastEntry?.type, "session_metadata");
    if (lastEntry?.type === "session_metadata") {
      assert.equal(lastEntry.metadata.aiTitle, "Pinned at transcript tail");
      assert.equal(lastEntry.metadata.isSnapshot, true);
    }
  }
});

test("TurnRunner persists a bounded prompt when title generation produces no title", async () => {
  const sessionId = "untitled-session";
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({
    transcript,
    sessionId,
    now: () => new Date(NOW),
  });
  const successfulResult = result(sessionId);
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: successfulResult };
      return { result: successfulResult, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
    transcript,
    undefined,
    () => new Date(NOW),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    {
      metadataStore,
      autoGenerateSessionTitle: true,
      sessionTitleGenerator: async () => null,
    },
  );

  const prompt = "Create a briefing";
  for await (const _event of runner.run({
    sessionId,
    turnId: "turn-1",
    messages: [],
    input: {
      type: "blocks",
      content: [
        { type: "text", text: prompt },
        { type: "image", source: "base64", data: "x".repeat(2 * 1024 * 1024), mimeType: "image/png" },
      ],
    },
  })) {
    // Exhaust the successful turn so its metadata reappend is persisted.
  }

  const lastEntry = transcript.entries.at(-1);
  assert.equal(lastEntry?.type, "session_metadata");
  if (lastEntry?.type === "session_metadata") {
    assert.equal(lastEntry.metadata.firstPrompt, prompt);
    assert.equal(lastEntry.metadata.lastPrompt, prompt);
    assert.equal(lastEntry.metadata.isSnapshot, true);
  }
});

test("TurnRunner updates lastPrompt on subsequent accepted turns", async () => {
  const sessionId = "two-turn-session";
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({
    transcript,
    sessionId,
    now: () => new Date(NOW),
  });
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      const successfulResult = result(input.sessionId);
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: successfulResult };
      return { result: successfulResult, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
    transcript,
    undefined,
    () => new Date(NOW),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    { metadataStore, autoGenerateSessionTitle: false },
  );

  for (const [turnId, prompt] of [["turn-1", "First prompt"], ["turn-2", "Second prompt"]] as const) {
    for await (const _event of runner.run({
      sessionId,
      turnId,
      messages: [],
      input: { type: "text", text: prompt },
    })) {
      // Exhaust each turn so the metadata snapshot is persisted.
    }
  }

  const lastEntry = transcript.entries.at(-1);
  assert.equal(lastEntry?.type, "session_metadata");
  if (lastEntry?.type === "session_metadata") {
    assert.equal(lastEntry.metadata.firstPrompt, "First prompt");
    assert.equal(lastEntry.metadata.lastPrompt, "Second prompt");
  }
});

test("TurnRunner carries complete metadata through a runtime reload snapshot", async () => {
  const sessionId = "reloaded-session";
  const originalTranscript = new InMemoryTranscriptWriter();
  const originalStore = new SessionMetadataStore({
    transcript: originalTranscript,
    sessionId,
    now: () => new Date(NOW),
  });
  await originalStore.record("turn-1", {
    title: "Original custom title",
    tag: "important",
    firstPrompt: "First prompt",
    lastPrompt: "First prompt",
    parentSessionId: "web:parent",
    forkedFromTurnId: "parent-turn",
  });
  const loop = { snapshotFileState: () => ({}) } as unknown as AgentLoop;
  const originalRunner = new TurnRunner(
    loop,
    originalTranscript,
    undefined,
    () => new Date(NOW),
    undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    { metadataStore: originalStore, autoGenerateSessionTitle: false },
  );

  const originalSession = new AgentSession({ sessionId, turnRunner: originalRunner });
  const reload = originalSession.snapshotForRuntimeReload();
  assert.deepEqual(reload.metadata, originalStore.getSnapshot());

  const reloadedTranscript = new InMemoryTranscriptWriter();
  const reloadedStore = new SessionMetadataStore({
    transcript: reloadedTranscript,
    sessionId,
    now: () => new Date(NOW),
  });
  reloadedStore.restoreFromReplay(reload.metadata ?? {});
  await reloadedStore.record("turn-2", { lastPrompt: "Second prompt" });
  await reloadedStore.saveAiTitle("Regenerated title", "turn-2");
  await reloadedStore.reappendTail("turn-2");

  const lastEntry = reloadedTranscript.entries.at(-1);
  assert.equal(lastEntry?.type, "session_metadata");
  if (lastEntry?.type === "session_metadata") {
    assert.equal(lastEntry.metadata.title, "Original custom title");
    assert.equal(lastEntry.metadata.aiTitle, "Regenerated title");
    assert.equal(lastEntry.metadata.firstPrompt, "First prompt");
    assert.equal(lastEntry.metadata.lastPrompt, "Second prompt");
    assert.equal(lastEntry.metadata.tag, "important");
    assert.equal(lastEntry.metadata.parentSessionId, "web:parent");
    assert.equal(lastEntry.metadata.forkedFromTurnId, "parent-turn");
    assert.equal(lastEntry.metadata.isSnapshot, true);
  }
});

test("TurnRunner persists a bounded prompt when a hook blocks a first turn", async () => {
  const sessionId = "blocked-session";
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({
    transcript,
    sessionId,
    now: () => new Date(NOW),
  });
  const lifecycle = {
    async dispatch() {
      return {
        effects: [{ type: "block", reason: "blocked by test" }],
        messages: [],
        events: [],
        blockingErrors: [],
        nonBlockingErrors: [],
      };
    },
  } as unknown as LifecycleRuntime;
  const loop = {
    async *run(): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      assert.fail("blocked turns must not run the model loop");
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
  const runner = new TurnRunner(
    loop,
    transcript,
    undefined,
    () => new Date(NOW),
    lifecycle,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    { metadataStore, autoGenerateSessionTitle: false },
  );

  const prompt = "p".repeat(2 * 1024 * 1024);
  for await (const _event of runner.run({
    sessionId,
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: prompt },
  })) {
    // Exhaust the blocked turn so its metadata reappend is persisted.
  }

  const lastEntry = transcript.entries.at(-1);
  assert.equal(lastEntry?.type, "session_metadata");
  if (lastEntry?.type === "session_metadata") {
    assert.equal(lastEntry.metadata.firstPrompt, prompt.slice(0, 1_200));
    assert.equal(lastEntry.metadata.lastPrompt, prompt.slice(0, 1_200));
  }
});

test("pending title generation does not hold subsequent turns and cannot overwrite a manual title", async () => {
  for (const manuallyRenamed of [false, true]) {
    const sessionId = `background-title-${manuallyRenamed}`;
    const transcript = new InMemoryTranscriptWriter();
    const metadataStore = new SessionMetadataStore({ transcript, sessionId });
    let resolveTitle!: (title: string) => void;
    const title = new Promise<string>((resolve) => { resolveTitle = resolve; });
    let titleCalls = 0;
    const loop = {
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        const completed = { ...result(sessionId), turnId: input.turnId };
        yield { type: "turn_completed", sessionId, turnId: input.turnId, result: completed };
        return { result: completed, messages: input.messages };
      },
    } as AgentLoop;
    const runner = new TurnRunner(loop, transcript, undefined, () => new Date(), undefined,
      { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
      { metadataStore, autoGenerateSessionTitle: true, sessionTitleGenerator: async () => { titleCalls++; return title; } });
    const session = new AgentSession({ sessionId, turnRunner: runner });
    const drain = async (text: string) => {
      for await (const _ of session.submit({ type: "text", text })) { /* drain */ }
    };
    // The old implementation cannot finish either turn until resolveTitle is called.
    try {
      await Promise.race([
        (async () => { await drain("First"); await drain("Second"); })(),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("title blocked turn completion")), 1000); timer.unref(); }),
      ]);
      assert.equal(session.snapshot().status, "idle");
      assert.equal(titleCalls, 1);
      assert.equal(metadataStore.getSnapshot().lastPrompt, "Second");
      if (manuallyRenamed) await metadataStore.saveTitle("My title");
    } finally { resolveTitle("Generated title"); }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(metadataStore.getSnapshot().lastPrompt, "Second");
    assert.equal(metadataStore.getSnapshot().aiTitle, manuallyRenamed ? undefined : "Generated title");
    assert.equal(metadataStore.getSnapshot().title, manuallyRenamed ? "My title" : undefined);
    assert.equal(transcript.entries.filter(entry => entry.type === "accepted_input").length, 2);
  }
});

for (const selection of ["override", "saved"] as const) {
  test(`first-turn title generation follows the ${selection} conversation model`, async () => {
    const sessionId = `selected-model-title-${selection}`;
    const transcript = new InMemoryTranscriptWriter();
    const metadataStore = new SessionMetadataStore({ transcript, sessionId });
    let titleModel: { provider: string; model: string } | undefined;
    const loop = {
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        const completed = result(sessionId);
        yield { type: "turn_completed", sessionId, turnId: input.turnId, result: completed };
        return { result: completed, messages: input.messages };
      },
    } as AgentLoop;
    const runner = new TurnRunner(loop, transcript, undefined, () => new Date(), undefined,
      { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
      { metadataStore, autoGenerateSessionTitle: true, sessionTitleGenerator: async input => {
        titleModel = input.model;
        return "比较配置文档";
      } });
    const session = new AgentSession({ sessionId, turnRunner: runner });

    for await (const _ of session.submit(
      { type: "text", text: "这两个配置页面有什么区别？" },
      selection === "override"
        ? { modelOverride: { provider: "working", model: "selected-model" } }
        : { modelSelection: { mode: "model", provider: "working", model: "selected-model" } },
    )) { /* drain */ }
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(titleModel, { provider: "working", model: "selected-model" });
    assert.equal(metadataStore.getSnapshot().aiTitle, "比较配置文档");
  });
}

test("title request failure does not fail a completed conversation", async () => {
  const sessionId = "failed-background-title";
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({ transcript, sessionId });
  let rejectTitle!: (error: Error) => void;
  const title = new Promise<string>((_, reject) => { rejectTitle = reject; });
  const loop = {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      const completed = result(sessionId);
      yield { type: "turn_completed", sessionId, turnId: input.turnId, result: completed };
      return { result: completed, messages: input.messages };
    },
  } as AgentLoop;
  const runner = new TurnRunner(loop, transcript, undefined, () => new Date(), undefined,
    { cwd: process.cwd(), transcriptPath: "", collectFileArtifacts: false },
    { metadataStore, autoGenerateSessionTitle: true, sessionTitleGenerator: async () => title });
  const session = new AgentSession({ sessionId, turnRunner: runner });
  for await (const _ of session.submit({ type: "text", text: "Hello" })) { /* drain */ }
  rejectTitle(new Error("title request timed out"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().status, "idle");
  assert.equal(metadataStore.getSnapshot().aiTitle, undefined);
});


for (const replace of [false, true]) {
  test(`closing a session prevents its late title from ${replace ? "changing a replacement transcript" : "recreating a deleted transcript"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pilotdeck-title-lifecycle-"));
    const path = join(directory, "session.jsonl");
    const sessionId = "web:late-title";
    const transcript = new JsonlTranscriptWriter({ path });
    const metadataStore = new SessionMetadataStore({ transcript, sessionId });
    let resolveTitle!: (title: string) => void;
    let signal: AbortSignal | undefined;
    const title = new Promise<string>(resolve => { resolveTitle = resolve; });
    const loop = {
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        const completed = result(sessionId);
        yield { type: "turn_completed", sessionId, turnId: input.turnId, result: completed };
        return { result: completed, messages: input.messages };
      },
    } as AgentLoop;
    const runner = new TurnRunner(loop, transcript, undefined, () => new Date(), undefined,
      { cwd: directory, transcriptPath: path, collectFileArtifacts: false },
      { metadataStore, autoGenerateSessionTitle: true, sessionTitleGenerator: async input => { signal = input.signal; return title; } });
    const router = new SessionRouter({ createSession: () => new AgentSession({ sessionId, turnRunner: runner }), idleSweepIntervalMs: 0 });
    try {
      const session = await router.getOrCreate({ sessionKey: sessionId, channelKey: "web" });
      for await (const _ of session.submit({ type: "text", text: "Old request" })) { /* drain */ }
      assert.match(await readFile(path, "utf8"), /Old request/);
      await router.close(sessionId);
      assert.equal(signal?.aborted, true);
      await rm(path);
      if (replace) await writeFile(path, "replacement transcript\n");
      // Deliberately ignore the abort signal, as an incompatible provider can.
      resolveTitle("Obsolete title");
      await new Promise(resolve => setImmediate(resolve));
      // Also exercise old queued callers after closure, not only the title guard.
      await metadataStore.saveAiTitle("Late direct write");
      if (replace) assert.equal(await readFile(path, "utf8"), "replacement transcript\n");
      else await assert.rejects(readFile(path), { code: "ENOENT" });
    } finally {
      resolveTitle("cleanup");
      await router.close(sessionId);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("closing a transcript drains in-flight writes and discards queued and future writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-writer-close-"));
  const path = join(directory, "session.jsonl");
  const writer = new JsonlTranscriptWriter({ path });
  try {
    await writer.recordSessionMetadata("s", "t", { title: "Original" });
    const queued = writer.recordSessionMetadata("s", "t", { aiTitle: "Queued" });
    await writer.close();
    await queued;
    await rm(path);
    await writer.recordSessionMetadata("s", "t", { aiTitle: "Too late" });
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("concurrent close and reopen wait for the previous session writer to drain", async () => {
  let finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  let created = 0;
  const router = new SessionRouter({
    createSession: () => { created++; return { dispose: () => closing } as unknown as AgentSession; },
    idleSweepIntervalMs: 0,
  });
  const context = {sessionKey: "web:closing", channelKey: "web"};
  await router.getOrCreate(context);
  const firstClose = router.close(context.sessionKey);
  let secondClosed = false;
  const secondClose = router.close(context.sessionKey).then(() => { secondClosed = true; });
  const reopened = router.getOrCreate(context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondClosed, false);
  assert.equal(created, 1);
  finishClose();
  await Promise.all([firstClose, secondClose, reopened]);
  assert.equal(secondClosed, true);
  assert.equal(created, 2);
  await router.close(context.sessionKey);
});

test("project closure waits for in-progress session creation and blocks new sessions until released", async () => {
  let finishCreate!: (session: AgentSession) => void;
  let disposed = 0;
  const pending = new Promise<AgentSession>(resolve => { finishCreate = resolve; });
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: context => context.projectKey === "/deleting" ? pending : ({ dispose: async () => {} } as unknown as AgentSession),
  });
  const creation = router.getOrCreate({sessionKey: "s", projectKey: "/deleting", channelKey: "web"}).catch(error => error);
  let closed = false;
  const closing = router.closeProject("/deleting").then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  await assert.rejects(router.getOrCreate({sessionKey: "new", projectKey: "/deleting", channelKey: "web"}), /being deleted/);
  await router.getOrCreate({sessionKey: "other", projectKey: "/other", channelKey: "web"});
  finishCreate({dispose: async () => { disposed++; }} as unknown as AgentSession);
  await closing;
  assert.match((await creation).message, /being deleted/);
  assert.ok(disposed > 0);
  router.resumeProject("/deleting");
  await router.getOrCreate({sessionKey: "after", projectKey: "/deleting", channelKey: "web"});
  router.shutdown();
});

test("project closure drains a session already being evicted", async () => {
  let finish!: () => void;
  const drained = new Promise<void>(resolve => { finish = resolve; });
  const router = new SessionRouter({idleSweepIntervalMs: 0, createSession: () => ({dispose: () => drained} as unknown as AgentSession)});
  await router.getOrCreate({sessionKey: "s", projectKey: "/project", channelKey: "web"});
  const closingSession = router.close("s");
  let closed = false;
  const closingProject = router.closeProject("/project").then(() => {closed = true;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  finish();
  await Promise.all([closingSession, closingProject]);
  assert.equal(closed, true);
  router.shutdown();
});
