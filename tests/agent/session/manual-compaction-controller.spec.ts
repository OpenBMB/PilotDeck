import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentContextRuntime, AutoCompactResult } from "../../../src/context/index.js";
import { createAgentSessionWithStorage } from "../../../src/agent/session/createAgentSession.js";
import { createInitialAgentSessionState } from "../../../src/agent/session/AgentSessionState.js";
import { AgentHandle } from "../../../src/agent/scope/AgentHandle.js";
import { AgentSession } from "../../../src/agent/session/AgentSession.js";
import { AgentSessionEventRecorder } from "../../../src/agent/session/AgentSessionEventRecorder.js";
import { ManualCompactionController } from "../../../src/agent/session/ManualCompactionController.js";
import { resumeAgentSession } from "../../../src/session/resume/resumeAgentSession.js";
import { createAgentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import { readTranscript } from "../../../src/session/transcript/TranscriptReader.js";
import { projectAgentTranscriptEntries } from "../../../src/session/projection/AgentTranscriptProjections.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";

const now = "2026-09-09T00:00:00.000Z";

test("manual compaction writes a standalone durable replacement without model-loop input", async () => {
  const transcript = new InMemoryTranscriptWriter({ now: () => new Date(now), uuid: ids("entry") });
  const recorder = new AgentSessionEventRecorder(transcript, { uuid: ids("operation") });
  let contextCalls = 0;
  const context: AgentContextRuntime = {
    prepareForModel: async () => ({ messages: [], systemPromptParts: [], tools: [], diagnostics: [], boundaries: [] }),
    tryAutoCompact: async (input) => {
      contextCalls += 1;
      assert.equal(input.trigger, "manual");
      assert.equal(input.manualForce, true);
      assert.equal(input.messages[0]?.content[0]?.type === "text" && input.messages[0].content[0].text, "old history");
      return compacted();
    },
  };
  const controller = new ManualCompactionController({
    sessionId: "session-manual",
    context,
    recorder,
    transcript,
    messages: () => [{ role: "user", content: [{ type: "text", text: "old history" }] }],
    now: () => new Date(now),
    uuid: ids("turn"),
  });

  const outcome = await controller.compact({ abortSignal: new AbortController().signal });

  assert.equal(contextCalls, 1);
  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "compaction_started",
    "control_boundary",
    "compaction_completed",
    "turn_result",
  ]);
  assert.equal(transcript.entries.some((entry) => entry.type === "accepted_input"), false);
  assert.equal(outcome.type, "compacted");
  const boundary = transcript.entries[2];
  assert.equal(boundary?.type, "control_boundary");
  if (boundary?.type === "control_boundary" && boundary.boundary.kind === "compact") {
    assert.equal(boundary.boundary.subtype, "compact_boundary");
    assert.equal(boundary.boundary.replacementMessages?.[0]?.metadata?.compactReplacement, true);
  }
  const replay = projectAgentTranscriptEntries(transcript.entries);
  assert.equal(replay.messages[0]?.content[0]?.type === "text" && replay.messages[0].content[0].text, "summary");
});

test("manual compaction records failure when the replacement cannot be appended", async () => {
  class FailingTranscript extends InMemoryTranscriptWriter {
    override recordCompactionReplacement(): Promise<void> {
      return Promise.reject(new Error("replacement unavailable"));
    }
  }
  const transcript = new FailingTranscript({ now: () => new Date(now), uuid: ids("entry") });
  const recorder = new AgentSessionEventRecorder(transcript, { uuid: ids("operation") });
  const controller = new ManualCompactionController({
    sessionId: "session-failed",
    context: compactingContext(),
    recorder,
    transcript,
    messages: () => [{ role: "user", content: [{ type: "text", text: "old history" }] }],
    now: () => new Date(now),
  });

  const outcome = await controller.compact({ abortSignal: new AbortController().signal, turnId: "turn-failed" });

  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "turn_started",
    "compaction_started",
    "compaction_failed",
    "turn_result",
  ]);
  assert.equal(outcome.type, "failed");
  assert.match(outcome.error, /replacement unavailable/);
});

test("AgentHandle maintenance blocks direct submit and leaves later followup FIFO behind compaction", async () => {
  let releaseCompact!: () => void;
  const compactGate = new Promise<void>((resolve) => { releaseCompact = resolve; });
  let compactStarted!: () => void;
  const started = new Promise<void>((resolve) => { compactStarted = resolve; });
  const calls: string[] = [];
  const session = {
    sessionId: "session-handle",
    pendingTurnCount: 0,
    pendingTurns: () => [],
    compact: async ({ abortSignal }: { abortSignal: AbortSignal; turnId: string }) => {
      calls.push("compact");
      compactStarted();
      await Promise.race([compactGate, aborted(abortSignal)]);
      return { type: "skipped" as const, turnId: "manual", reason: "no_compactable_history" as const, usage: {} };
    },
    enqueueTurn: async () => { calls.push("followup"); },
    discardQueuedTurns: async () => undefined,
    snapshot: () => ({ sessionId: "session-handle", messages: [], usage: {}, status: "idle", permissionDenials: [], abortController: new AbortController() }),
  } as unknown as AgentSession;
  const handle = new AgentHandle(session);
  const compact = handle.compact({ turnId: "manual" });
  await started;
  await assert.rejects(
    handle.submit({ type: "text", text: "cannot bypass" }).next(),
    /already has an active turn/,
  );
  const followup = handle.followup({ type: "text", text: "later" }, { itemId: "later", turnId: "later" });
  assert.deepEqual(calls, ["compact"]);
  releaseCompact();
  await compact;
  await followup;
  assert.deepEqual(calls, ["compact", "followup"]);
  await handle.dispose();
});

test("AgentHandle abort cancels an in-flight maintenance request", async () => {
  let maintenanceStarted!: () => void;
  const started = new Promise<void>((resolve) => { maintenanceStarted = resolve; });
  const session = {
    sessionId: "session-cancel",
    pendingTurnCount: 0,
    pendingTurns: () => [],
    compact: async ({ abortSignal }: { abortSignal: AbortSignal; turnId: string }) => {
      maintenanceStarted();
      await aborted(abortSignal);
      throw new Error("maintenance cancelled");
    },
    abort: () => undefined,
    discardQueuedTurns: async () => undefined,
    snapshot: () => ({ sessionId: "session-cancel", messages: [], usage: {}, status: "idle", permissionDenials: [], abortController: new AbortController() }),
  } as unknown as AgentSession;
  const handle = new AgentHandle(session);
  const maintenance = handle.compact({ turnId: "manual" });
  await started;
  handle.abort("user_cancelled");
  await assert.rejects(maintenance, /maintenance cancelled/);
  await handle.dispose();
});

test("cancelled manual compaction before replacement commit replays original history into the next model request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-manual-compaction-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sessionId = "session-manual-cancel-recovery";
  const history: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "original request" }] },
    { role: "assistant", content: [{ type: "text", text: "original response" }] },
  ];
  const storage = createAgentProjectSessionStorage({ projectRoot: root, pilotHome: root, sessionId });
  await storage.transcript.recordAcceptedInput(sessionId, "seed", [history[0]!]);
  await storage.transcript.recordDurableMessage(sessionId, "seed", history[1]!);
  await storage.transcript.recordTurnResult(sessionId, "seed", successfulTurn(sessionId, "seed"));

  const cancellation = new AbortController();
  const initialState = createInitialAgentSessionState(sessionId);
  initialState.messages = structuredClone(history);
  const created = createAgentSessionWithStorage({
    sessionId,
    config: sessionConfig(root),
    storage,
    initialState,
    collectFileArtifacts: false,
    dependencies: sessionDependencies({
      context: {
        prepareForModel: prepareOriginalMessages,
        tryAutoCompact: async () => {
          // The summary has been produced, but cancellation wins before the
          // controller can append its replacement boundary.
          cancellation.abort("cancel_before_replacement_commit");
          return compacted();
        },
      },
    }),
  });

  const cancelled = await created.session.compact({
    turnId: "manual-cancelled",
    abortSignal: cancellation.signal,
  });
  assert.equal(cancelled.type, "aborted");
  await created.handle.dispose();

  const afterCancellation = await readTranscript(storage.transcriptPath);
  assert.deepEqual(afterCancellation.diagnostics, []);
  assert.deepEqual(
    afterCancellation.entries.map((entry) => entry.type),
    [
      "accepted_input",
      "assistant_message",
      "turn_result",
      "turn_started",
      "compaction_started",
      "compaction_failed",
      "turn_result",
    ],
  );
  assert.equal(afterCancellation.entries.some((entry) => entry.type === "control_boundary"), false);

  const modelRequests: CanonicalModelRequest[] = [];
  const resumed = await resumeAgentSession({
    sessionId,
    projectStorage: { projectRoot: root, pilotHome: root },
    config: sessionConfig(root),
    collectFileArtifacts: false,
    dependencies: sessionDependencies({
      context: { prepareForModel: prepareOriginalMessages },
      modelRequests,
    }),
  });
  try {
    for await (const _event of resumed.session.submit(
      { type: "text", text: "continue after recovery" },
      { turnId: "after-recovery", maxTurns: 1 },
    )) {
      // Drain the native AgentLoop to its recorded model request.
    }
  } finally {
    await resumed.handle.dispose();
  }

  assert.equal(modelRequests.length, 1);
  assert.deepEqual(modelRequests[0]!.messages.map(messageText), [
    "original request",
    "original response",
    "continue after recovery",
  ]);
  const recovered = await readTranscript(resumed.transcriptPath);
  assert.deepEqual(recovered.diagnostics, []);
  assert.equal(recovered.entries.filter((entry) => entry.type === "compaction_started").length, 1);
  assert.equal(recovered.entries.some((entry) => entry.type === "control_boundary"), false);
});

test("manual compaction missing a durable summary preserves original history after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-manual-compaction-missing-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sessionId = "session-manual-missing-summary";
  const history: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "original request" }] },
    { role: "assistant", content: [{ type: "text", text: "original response" }] },
  ];
  const storage = createAgentProjectSessionStorage({ projectRoot: root, pilotHome: root, sessionId });
  await storage.transcript.recordAcceptedInput(sessionId, "seed", [history[0]!]);
  await storage.transcript.recordDurableMessage(sessionId, "seed", history[1]!);
  await storage.transcript.recordTurnResult(sessionId, "seed", successfulTurn(sessionId, "seed"));

  const initialState = createInitialAgentSessionState(sessionId);
  initialState.messages = structuredClone(history);
  const created = createAgentSessionWithStorage({
    sessionId,
    config: sessionConfig(root),
    storage,
    initialState,
    collectFileArtifacts: false,
    dependencies: sessionDependencies({
      context: {
        prepareForModel: prepareOriginalMessages,
        tryAutoCompact: async () => ({
          type: "compacted",
          messages: [{ role: "user", content: [{ type: "text", text: "non-durable summary" }] }],
          tier: "full",
          snapshot: { tokens: 20, maxContextTokens: 100, warningRatio: 0.8, blockingRatio: 0.9, state: "ok", ratio: 0.2 },
        }),
      },
    }),
  });

  const missingSummary = await created.session.compact({
    turnId: "manual-missing-summary",
    abortSignal: new AbortController().signal,
  });
  assert.equal(missingSummary.type, "failed");
  assert.match(missingSummary.error, /no durable replacement result/);
  await created.handle.dispose();

  const failedTranscript = await readTranscript(storage.transcriptPath);
  assert.deepEqual(failedTranscript.diagnostics, []);
  assert.equal(failedTranscript.entries.filter((entry) => entry.type === "compaction_started").length, 1);
  assert.equal(failedTranscript.entries.filter((entry) => entry.type === "compaction_failed").length, 1);
  assert.equal(failedTranscript.entries.some((entry) => entry.type === "control_boundary"), false);

  const modelRequests: CanonicalModelRequest[] = [];
  const resumed = await resumeAgentSession({
    sessionId,
    projectStorage: { projectRoot: root, pilotHome: root },
    config: sessionConfig(root),
    collectFileArtifacts: false,
    dependencies: sessionDependencies({
      context: { prepareForModel: prepareOriginalMessages },
      modelRequests,
    }),
  });
  try {
    for await (const _event of resumed.session.submit(
      { type: "text", text: "continue after missing summary" },
      { turnId: "after-missing-summary", maxTurns: 1 },
    )) {
      // Drain the native AgentLoop to its recorded model request.
    }
  } finally {
    await resumed.handle.dispose();
  }

  assert.equal(modelRequests.length, 1);
  assert.deepEqual(modelRequests[0]!.messages.map(messageText), [
    "original request",
    "original response",
    "continue after missing summary",
  ]);
});

test("abort during an uncommitted replacement write preserves original history after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-manual-compaction-write-race-before-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sessionId = "session-manual-write-race-before";
  const history: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "original request" }] },
    { role: "assistant", content: [{ type: "text", text: "original response" }] },
  ];
  const storage = createAgentProjectSessionStorage({ projectRoot: root, pilotHome: root, sessionId });
  await storage.transcript.recordAcceptedInput(sessionId, "seed", [history[0]!]);
  await storage.transcript.recordDurableMessage(sessionId, "seed", history[1]!);
  await storage.transcript.recordTurnResult(sessionId, "seed", successfulTurn(sessionId, "seed"));

  const cancellation = new AbortController();
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  const recordReplacement = storage.transcript.recordCompactionReplacement.bind(storage.transcript);
  storage.transcript.recordCompactionReplacement = async (...args) => {
    writeStarted.resolve();
    await releaseWrite.promise;
    cancellation.signal.throwIfAborted();
    await recordReplacement(...args);
  };
  const initialState = createInitialAgentSessionState(sessionId);
  initialState.messages = structuredClone(history);
  const created = createAgentSessionWithStorage({
    sessionId,
    config: sessionConfig(root),
    storage,
    initialState,
    collectFileArtifacts: false,
    dependencies: sessionDependencies({
      context: { prepareForModel: prepareOriginalMessages, tryAutoCompact: async () => compacted() },
    }),
  });

  const pending = created.session.compact({ turnId: "write-race-before", abortSignal: cancellation.signal });
  await writeStarted.promise;
  cancellation.abort(new Error("cancel_before_durable_replacement"));
  releaseWrite.resolve();
  const outcome = await pending;
  assert.equal(outcome.type, "aborted");
  await created.handle.dispose();

  const failed = await readTranscript(storage.transcriptPath);
  assert.equal(failed.entries.filter((entry) => entry.type === "compaction_started").length, 1);
  assert.equal(failed.entries.filter((entry) => entry.type === "compaction_failed").length, 1);
  assert.equal(failed.entries.some((entry) => entry.type === "control_boundary"), false);

  const modelRequests: CanonicalModelRequest[] = [];
  const resumed = await resumeAgentSession({
    sessionId,
    projectStorage: { projectRoot: root, pilotHome: root },
    config: sessionConfig(root),
    collectFileArtifacts: false,
    dependencies: sessionDependencies({ context: { prepareForModel: prepareOriginalMessages }, modelRequests }),
  });
  try {
    for await (const _event of resumed.session.submit(
      { type: "text", text: "continue after write race" },
      { turnId: "after-write-race", maxTurns: 1 },
    )) {
      // Drain the native AgentLoop to its recorded model request.
    }
  } finally {
    await resumed.handle.dispose();
  }
  assert.deepEqual(modelRequests[0]!.messages.map(messageText), [
    "original request",
    "original response",
    "continue after write race",
  ]);
});

test("abort after an atomic replacement write keeps one committed boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-manual-compaction-write-race-after-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sessionId = "session-manual-write-race-after";
  const storage = createAgentProjectSessionStorage({ projectRoot: root, pilotHome: root, sessionId });
  const cancellation = new AbortController();
  let replacementWrites = 0;
  const recordReplacement = storage.transcript.recordCompactionReplacement.bind(storage.transcript);
  storage.transcript.recordCompactionReplacement = async (...args) => {
    replacementWrites += 1;
    await recordReplacement(...args);
    cancellation.abort(new Error("cancel_after_durable_replacement"));
  };
  const initialState = createInitialAgentSessionState(sessionId);
  initialState.messages = [{ role: "user", content: [{ type: "text", text: "replace once" }] }];
  const created = createAgentSessionWithStorage({
    sessionId,
    config: sessionConfig(root),
    storage,
    initialState,
    collectFileArtifacts: false,
    dependencies: sessionDependencies({ context: { prepareForModel: prepareOriginalMessages, tryAutoCompact: async () => compacted() } }),
  });

  const outcome = await created.session.compact({ turnId: "write-race-after", abortSignal: cancellation.signal });
  assert.equal(outcome.type, "compacted");
  await created.handle.dispose();

  const committed = await readTranscript(storage.transcriptPath);
  assert.equal(replacementWrites, 1);
  assert.equal(committed.entries.filter((entry) => entry.type === "control_boundary").length, 1);
  assert.equal(committed.entries.filter((entry) => entry.type === "compaction_completed").length, 1);
  assert.equal(committed.entries.filter((entry) => entry.type === "compaction_failed").length, 0);
});

test("committed manual compaction replays one replacement into the next model request after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-manual-compaction-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sessionId = "session-manual-commit-recovery";
  const history: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "replace this request" }] },
    { role: "assistant", content: [{ type: "text", text: "replace this response" }] },
  ];
  const storage = createAgentProjectSessionStorage({ projectRoot: root, pilotHome: root, sessionId });
  await storage.transcript.recordAcceptedInput(sessionId, "seed", [history[0]!]);
  await storage.transcript.recordDurableMessage(sessionId, "seed", history[1]!);
  await storage.transcript.recordTurnResult(sessionId, "seed", successfulTurn(sessionId, "seed"));

  const initialState = createInitialAgentSessionState(sessionId);
  initialState.messages = structuredClone(history);
  const created = createAgentSessionWithStorage({
    sessionId,
    config: sessionConfig(root),
    storage,
    initialState,
    collectFileArtifacts: false,
    dependencies: sessionDependencies({
      context: {
        prepareForModel: prepareOriginalMessages,
        tryAutoCompact: async () => compacted(),
      },
    }),
  });

  const committed = await created.session.compact({
    turnId: "manual-committed",
    abortSignal: new AbortController().signal,
  });
  assert.equal(committed.type, "compacted");
  await created.handle.dispose();

  const beforeRestart = await readTranscript(storage.transcriptPath);
  assert.deepEqual(beforeRestart.diagnostics, []);
  assert.equal(beforeRestart.entries.filter((entry) => entry.type === "control_boundary").length, 1);

  const modelRequests: CanonicalModelRequest[] = [];
  const resumed = await resumeAgentSession({
    sessionId,
    projectStorage: { projectRoot: root, pilotHome: root },
    config: sessionConfig(root),
    collectFileArtifacts: false,
    dependencies: sessionDependencies({
      context: { prepareForModel: prepareOriginalMessages },
      modelRequests,
    }),
  });
  try {
    for await (const _event of resumed.session.submit(
      { type: "text", text: "continue from the checkpoint" },
      { turnId: "after-commit-recovery", maxTurns: 1 },
    )) {
      // Drain the native AgentLoop to its recorded model request.
    }
  } finally {
    await resumed.handle.dispose();
  }

  assert.equal(modelRequests.length, 1);
  assert.deepEqual(modelRequests[0]!.messages.map(messageText), [
    "summary",
    "continue from the checkpoint",
  ]);
  const recovered = await readTranscript(resumed.transcriptPath);
  assert.deepEqual(recovered.diagnostics, []);
  assert.equal(recovered.entries.filter((entry) => entry.type === "control_boundary").length, 1);
  assert.equal(recovered.entries.filter((entry) => entry.type === "compaction_started").length, 1);
});

function compactingContext(): AgentContextRuntime {
  return {
    prepareForModel: async () => ({ messages: [], systemPromptParts: [], tools: [], diagnostics: [], boundaries: [] }),
    tryAutoCompact: async () => compacted(),
  };
}

function compacted(): AutoCompactResult {
  const message = { role: "user" as const, content: [{ type: "text" as const, text: "summary" }] };
  return {
    type: "compacted",
    messages: [message],
    tier: "full",
    snapshot: { tokens: 20, maxContextTokens: 100, warningRatio: 0.8, blockingRatio: 0.9, state: "ok", ratio: 0.2 },
    result: {
      compactionId: "compact-1",
      trigger: "manual",
      preTokens: 100,
      postTokens: 20,
      messagesSummarized: 1,
      summaryMessage: message,
      boundaryMarker: message,
      messagesToKeep: [],
      attachments: [],
      hookResults: [],
      diagnostics: [],
    },
  };
}

const prepareOriginalMessages: AgentContextRuntime["prepareForModel"] = async (input) => ({
  messages: input.messages,
  systemPromptParts: [],
  tools: input.tools,
  diagnostics: [],
  boundaries: [],
});

function sessionConfig(cwd: string) {
  return {
    provider: "test",
    model: "test",
    cwd,
    permissionMode: "default" as const,
    permissionContext: {
      mode: "default" as const,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function sessionDependencies(input: {
  context: AgentContextRuntime;
  modelRequests?: CanonicalModelRequest[];
}) {
  return {
    router: {} as never,
    context: input.context,
    tools: { registry: { list: () => [] } as never },
    ports: {
      model: {
        async prepare({ request }: { request: CanonicalModelRequest }) {
          input.modelRequests?.push(structuredClone(request));
          return { request, provider: request.provider, model: request.model };
        },
        async *stream() {
          yield { type: "message_start" as const, role: "assistant" as const };
          yield { type: "text_delta" as const, text: "recovered response" };
          yield { type: "message_end" as const, finishReason: "stop" as const };
        },
      },
    },
  };
}

function successfulTurn(sessionId: string, turnId: string) {
  return {
    type: "success" as const,
    sessionId,
    turnId,
    stopReason: "completed" as const,
    usage: {},
    permissionDenials: [],
    turns: 0,
    startedAt: now,
    completedAt: now,
  };
}

function messageText(message: CanonicalMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function ids(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => { resolve = next; }),
    resolve,
  };
}
