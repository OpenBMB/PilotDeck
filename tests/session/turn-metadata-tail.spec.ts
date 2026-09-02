import test from "node:test";
import assert from "node:assert/strict";

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
