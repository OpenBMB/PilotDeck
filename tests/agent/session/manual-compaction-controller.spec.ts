import assert from "node:assert/strict";
import test from "node:test";

import type { AgentContextRuntime, AutoCompactResult } from "../../../src/context/index.js";
import { AgentHandle } from "../../../src/agent/scope/AgentHandle.js";
import { AgentSession } from "../../../src/agent/session/AgentSession.js";
import { AgentSessionEventRecorder } from "../../../src/agent/session/AgentSessionEventRecorder.js";
import { ManualCompactionController } from "../../../src/agent/session/ManualCompactionController.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import { projectAgentTranscriptEntries } from "../../../src/session/projection/AgentTranscriptProjections.js";

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
    assert.equal(boundary.boundary.snapshot?.messages[0]?.metadata?.compactReplacement, true);
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

test("AgentSession permits manual compaction from failed and aborted terminal states", async () => {
  for (const status of ["failed", "aborted"] as const) {
    let calls = 0;
    const session = new AgentSession({
      sessionId: `session-${status}`,
      turnRunner: { sessionEventRecorder: {} } as never,
      initialState: {
        sessionId: `session-${status}`,
        messages: [],
        usage: {},
        status,
        permissionDenials: [],
        abortController: new AbortController(),
      },
      manualCompactionController: {
        async compact({ turnId }) {
          calls += 1;
          return { type: "skipped", turnId: turnId ?? "manual", reason: "no_compactable_history", usage: {} };
        },
      } as ManualCompactionController,
    });

    const result = await session.compact({ abortSignal: new AbortController().signal, turnId: "manual" });
    assert.equal(result.type, "skipped");
    assert.equal(calls, 1);
    assert.equal(session.snapshot().status, "idle");
  }
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

function ids(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
