import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionAgentLoopOperationLedger } from "../../../src/agent/modules/transport/sessionOperationLedger.js";
import { createAgentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";

test("session operation ledger replays a durable sidecar terminal", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const ledger = new SessionAgentLoopOperationLedger({
    sessionId: "ledger-session",
    transcript,
  });
  const identity = operationIdentity();
  const accepted = { ...identity, streamId: "stream-1" };

  await ledger.start(identity);
  await ledger.accept(accepted);
  await ledger.terminal({
    ...identity,
    streamId: "stream-1",
    lastAppliedSequence: 2,
    outcome: "completed",
    result: completedResult(),
    messages: [{ role: "assistant", content: [{ type: "text", text: "durably settled" }] }],
    seedState: { allowedReadFiles: ["/workspace/ledger.txt"] },
  });

  assert.deepEqual(transcript.entries.map((entry) => entry.type), [
    "agent_loop_operation_started",
    "agent_loop_operation_accepted",
    "agent_loop_operation_terminal",
  ]);

  const restored = new SessionAgentLoopOperationLedger({
    sessionId: "ledger-session",
    transcript,
    restoredEntries: transcript.entries,
  });
  const resolution = restored.reconcile({
    ...accepted,
    lastAppliedSequence: 2,
    code: "TRANSPORT_INTERRUPTED",
  });
  assert.equal(resolution?.outcome, "completed");
  assert.equal(resolution?.result.type, "success");
  assert.deepEqual(resolution?.messages, [
    { role: "assistant", content: [{ type: "text", text: "durably settled" }] },
  ]);
  assert.deepEqual(resolution?.seedState?.allowedReadFiles, ["/workspace/ledger.txt"]);
});

test("session operation ledger fails closed until a resolving sidecar attempt has a durable terminal", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const ledger = new SessionAgentLoopOperationLedger({
    sessionId: "ledger-session",
    transcript,
  });
  const identity = operationIdentity();
  const accepted = { ...identity, streamId: "stream-unknown" };
  const unknown = {
    ...accepted,
    lastAppliedSequence: 0,
    code: "DEADLINE_EXCEEDED",
  };

  await ledger.start(identity);
  await ledger.accept(accepted);
  await ledger.resultUnknown(unknown);
  assert.equal(ledger.reconcile(unknown), undefined);

  await ledger.terminal({
    ...identity,
    streamId: "stream-unknown",
    lastAppliedSequence: 0,
    outcome: "failed",
    result: failedResult(),
    messages: [],
    code: "DEADLINE_EXCEEDED",
  });
  const resolution = ledger.reconcile(unknown);
  assert.equal(resolution?.outcome, "failed");
  assert.equal(resolution?.result.type, "error");
  assert.deepEqual(
    transcript.entries
      .filter((entry) => entry.type === "agent_loop_operation_terminal")
      .map((entry) => entry.outcome),
    ["result_unknown", "failed"],
  );
});

test("session operation ledger restores from the session JSONL backend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-operation-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "ledger-session",
  });
  const ledger = new SessionAgentLoopOperationLedger({
    sessionId: "ledger-session",
    transcript: storage.transcript,
  });
  const identity = operationIdentity();
  const accepted = { ...identity, streamId: "stream-jsonl" };
  await ledger.start(identity);
  await ledger.accept(accepted);
  await ledger.terminal({
    ...identity,
    streamId: "stream-jsonl",
    lastAppliedSequence: 1,
    outcome: "cancelled",
    result: cancelledResult(),
    messages: [],
  });
  await storage.dispose();

  const resumedStorage = createAgentProjectSessionStorage({
    projectRoot: root,
    pilotHome: root,
    sessionId: "ledger-session",
  });
  const restored = await resumedStorage.restore();
  const resumedLedger = new SessionAgentLoopOperationLedger({
    sessionId: "ledger-session",
    transcript: resumedStorage.transcript,
    restoredEntries: restored.entries,
  });
  const resolution = resumedLedger.reconcile({
    ...accepted,
    lastAppliedSequence: 1,
    code: "TRANSPORT_INTERRUPTED",
  });
  assert.equal(resolution?.outcome, "cancelled");
  assert.equal(resolution?.result.type, "aborted");
  await resumedStorage.dispose();
});

test("session operation ledger recovers a durable terminal across transport attempt identities", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const ledger = new SessionAgentLoopOperationLedger({
    sessionId: "ledger-session",
    transcript,
  });
  const identity = operationIdentity();
  await ledger.start(identity);
  await ledger.accept({ ...identity, streamId: "stream-original" });
  await ledger.terminal({
    ...identity,
    streamId: "stream-original",
    lastAppliedSequence: 1,
    outcome: "completed",
    result: completedResult(),
    messages: [],
  });

  const recovered = ledger.recover({
    ...identity,
    requestId: "ledger-request-after-restart",
    binding: {
      moduleInstanceId: "ledger-sidecar-restarted",
      connectionGeneration: "ledger-connection-restarted",
    },
  });
  assert.equal(recovered?.state, "terminal");
  assert.equal(recovered?.state === "terminal" ? recovered.resolution.result.type : undefined, "success");
});

function operationIdentity() {
  return {
    runId: "ledger-run",
    operationId: "ledger-operation",
    requestId: "ledger-request",
    sessionId: "ledger-session",
    turnId: "ledger-turn",
    binding: {
      moduleInstanceId: "ledger-sidecar",
      connectionGeneration: "ledger-connection",
    },
  };
}

function completedResult() {
  return {
    type: "success" as const,
    sessionId: "ledger-session",
    turnId: "ledger-turn",
    stopReason: "completed" as const,
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: "2026-09-10T00:00:00.001Z",
  };
}

function failedResult() {
  return {
    type: "error" as const,
    sessionId: "ledger-session",
    turnId: "ledger-turn",
    stopReason: "model_error" as const,
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: "2026-09-10T00:00:00.001Z",
  };
}

function cancelledResult() {
  return {
    type: "aborted" as const,
    sessionId: "ledger-session",
    turnId: "ledger-turn",
    stopReason: "aborted_streaming" as const,
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: "2026-09-10T00:00:00.001Z",
  };
}
