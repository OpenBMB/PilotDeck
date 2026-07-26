import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlObservationRecorder,
  readObservationEvents,
  verifyObservationEvents,
  observeAgentEvent,
  type ObservationEvent,
  type ObservationEventDraft,
  type ObservationRecorder,
} from "../../src/observability/index.js";

test("subagent tool detection and result pair at the model projection layer", () => {
  const drafts: ObservationEventDraft[] = [];
  const recorder = {
    emit: (draft: ObservationEventDraft) => {
      drafts.push(draft);
      return undefined;
    },
  } as unknown as ObservationRecorder;

  observeAgentEvent(recorder, {
    type: "subagent_tool_calls_detected",
    sessionId: "parent-1",
    turnId: "parent-turn-1",
    subagentId: "sub-1",
    subagentType: "researcher",
    calls: [{ id: "tool-1", name: "read_file", input: { path: "/private/input" } }],
  });
  // Internal execution lifecycle events are deliberately not O1 span
  // boundaries because nested tools do not have top-level result projections.
  observeAgentEvent(recorder, {
    type: "pre_tool_execute",
    sessionId: "subagent:researcher:sub-1",
    turnId: "sub-turn-1",
    toolCallId: "tool-1:code:1",
    toolName: "read_file",
  });
  observeAgentEvent(recorder, {
    type: "post_tool_execute",
    sessionId: "subagent:researcher:sub-1",
    turnId: "sub-turn-1",
    toolCallId: "tool-1:code:1",
    toolName: "read_file",
    success: true,
  });
  observeAgentEvent(recorder, {
    type: "subagent_tool_result",
    sessionId: "parent-1",
    turnId: "parent-turn-1",
    subagentId: "sub-1",
    subagentType: "researcher",
    result: {
      type: "success",
      toolCallId: "tool-1",
      toolName: "read_file",
      content: [{ type: "text", text: "private tool output" }],
      startedAt: "2026-07-26T00:00:00.000Z",
      completedAt: "2026-07-26T00:00:01.000Z",
    },
  });

  assert.equal(drafts.length, 2);
  assert.equal(drafts[0]?.type, "tool.call.started");
  assert.equal(drafts[0]?.payload?.subagentId, "sub-1");
  assert.equal(drafts[1]?.type, "tool.call.completed");
  assert.equal(drafts[1]?.payload?.toolCallId, "tool-1");
  assert.equal(drafts[1]?.payload?.subagentId, "sub-1");
  assert.equal(typeof drafts[1]?.payload?.outputHash, "string");
  assert.equal(JSON.stringify(drafts).includes("private tool output"), false);
});

test("main tool detection and result produce one exact O1 pair", () => {
  const drafts: ObservationEventDraft[] = [];
  const recorder = {
    emit: (draft: ObservationEventDraft) => {
      drafts.push(draft);
      return undefined;
    },
  } as unknown as ObservationRecorder;

  observeAgentEvent(recorder, {
    type: "tool_calls_detected",
    sessionId: "session-1",
    turnId: "turn-1",
    calls: [{ id: "tool-main", name: "read_file", input: { path: "/private/input" } }],
  });
  observeAgentEvent(recorder, {
    type: "tool_result",
    sessionId: "session-1",
    turnId: "turn-1",
    result: {
      type: "success",
      toolCallId: "tool-main",
      toolName: "read_file",
      content: [{ type: "text", text: "private tool output" }],
      startedAt: "2026-07-26T00:00:00.000Z",
      completedAt: "2026-07-26T00:00:01.000Z",
    },
  });

  assert.deepEqual(drafts.map((draft) => draft.type), [
    "tool.call.started",
    "tool.call.completed",
  ]);
  assert.equal(drafts[0]?.payload?.toolCallId, "tool-main");
  assert.equal(drafts[1]?.payload?.toolCallId, "tool-main");
  assert.equal(JSON.stringify(drafts).includes("private tool output"), false);
});

test("repair feedback grace is observable without becoming progress", () => {
  const drafts: ObservationEventDraft[] = [];
  const recorder = {
    emit: (draft: ObservationEventDraft) => {
      drafts.push(draft);
      return undefined;
    },
  } as unknown as ObservationRecorder;

  observeAgentEvent(recorder, {
    type: "progress_lease_evaluated",
    sessionId: "session-1",
    turnId: "turn-1",
    scope: "legal-coverage",
    phase: "sources",
    blockingCode: "source_pending",
    remainingCount: 33,
    progressOrdinal: 1,
    repairOrdinal: 1,
    stagnantObservations: 3,
    decision: "feedback_grace",
    forceBoundaryNext: false,
  });

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.type, "harness.decision");
  assert.equal(drafts[0]?.payload?.policyVersion, "progress-lease/v3");
  assert.equal(drafts[0]?.payload?.decision, "feedback_grace");
  assert.deepEqual(drafts[0]?.payload?.observed, {
    scope: "legal-coverage",
    phase: "sources",
    blockingCode: "source_pending",
    remainingCount: 33,
    progressOrdinal: 1,
    repairOrdinal: 1,
    stagnantObservations: 3,
  });
});

test("recorder finalizes a complete hash-only trajectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-observation-recorder-"));
  try {
    let id = 0;
    const recorder = new JsonlObservationRecorder({
      directory: root,
      campaignId: "campaign-o1",
      variant: "candidate",
      uuid: () => `event-${++id}`,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });
    recorder.emit({ type: "turn.started", sessionId: "s1", turnId: "r1" });
    recorder.emit({
      type: "model.request.sent",
      sessionId: "s1",
      turnId: "r1",
      payload: { requestId: "req1", requestHash: "sha256:request" },
      priority: "critical",
    });
    recorder.emit({
      type: "model.response.received",
      sessionId: "s1",
      turnId: "r1",
      payload: { requestId: "req1", responseHash: "sha256:response" },
      priority: "critical",
    });
    recorder.emit({
      type: "tool.call.started",
      sessionId: "s1",
      turnId: "r1",
      payload: { toolCallId: "tool1", toolName: "read_file" },
      priority: "critical",
    });
    recorder.emit({
      type: "tool.call.completed",
      sessionId: "s1",
      turnId: "r1",
      payload: { toolCallId: "tool1", outputHash: "sha256:output" },
      priority: "critical",
    });
    recorder.emit({ type: "turn.completed", sessionId: "s1", turnId: "r1", priority: "critical" });

    const stats = await recorder.finalize();
    assert.equal(stats.droppedEvents, 0);
    const integrity = JSON.parse(await readFile(recorder.paths.integrity, "utf8"));
    const trajectory = JSON.parse(await readFile(recorder.paths.trajectory, "utf8"));
    assert.equal(integrity.status, "complete");
    if (process.platform !== "win32") {
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      assert.equal((await stat(recorder.paths.observations)).mode & 0o777, 0o600);
      assert.equal((await stat(recorder.paths.trajectory)).mode & 0o777, 0o600);
      assert.equal((await stat(recorder.paths.integrity)).mode & 0o777, 0o600);
    }
    assert.equal(integrity.checks.modelRequestsPaired, true);
    assert.equal(integrity.checks.toolCallsPaired, true);
    assert.equal(trajectory.source, "observations.jsonl");
    assert.equal(trajectory.steps[0].sourceEventId, "event-1");
    assert.equal(trajectory.steps.length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queue overflow is explicit and makes integrity partial", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-observation-overflow-"));
  try {
    const recorder = new JsonlObservationRecorder({ directory: root, queueCapacity: 64 });
    for (let index = 0; index < 256; index += 1) {
      recorder.emit({ type: "metric.sample", sessionId: "s1", payload: { index }, priority: "metrics" });
    }
    const stats = await recorder.finalize();
    const events = await readObservationEvents(recorder.paths.observations);
    const integrity = verifyObservationEvents(events, stats);
    assert.ok(stats.droppedEvents > 0);
    assert.equal(events.some((event) => event.type === "observation.gap"), true);
    assert.equal(integrity.status, "partial");
    assert.equal(integrity.checks.recorderHealthy, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifier rejects reused model request identity and duplicate terminals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-observation-request-identity-"));
  try {
    const recorder = new JsonlObservationRecorder({ directory: root });
    for (let index = 0; index < 2; index += 1) {
      recorder.emit({
        type: "model.request.sent",
        sessionId: "s1",
        turnId: "r1",
        payload: { requestId: "reused-request" },
        priority: "critical",
      });
      recorder.emit({
        type: "model.response.received",
        sessionId: "s1",
        turnId: "r1",
        payload: { requestId: "reused-request" },
        priority: "critical",
      });
    }
    await recorder.finalize();
    const integrity = JSON.parse(await readFile(recorder.paths.integrity, "utf8"));
    const codes = integrity.omissions.map((entry: { code: string }) => entry.code);

    assert.equal(integrity.status, "partial");
    assert.equal(integrity.checks.modelRequestsPaired, false);
    assert.equal(codes.includes("model_request_id_duplicate"), true);
    assert.equal(codes.includes("model_request_terminal_duplicate"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifier rejects duplicate identity and secret-bearing keys", () => {
  const base = {
    schemaVersion: "1.0",
    eventId: "duplicate",
    sequence: 1,
    timestamp: "2026-07-26T00:00:00.000Z",
    sessionId: "s1",
    producer: { component: "pilotdeck-core", version: "test" },
    type: "turn.started",
    priority: "critical",
    payload: { authorization: "must-not-persist" },
    security: { classification: "internal", contentAvailable: false, redactions: [] },
  } satisfies ObservationEvent;
  const report = verifyObservationEvents([
    base,
    { ...base, sequence: 2 },
  ], {
    acceptedEvents: 2,
    droppedEvents: 0,
    droppedByPriority: {},
    queueHighWatermark: 2,
    bytesWritten: 0,
    writeBatches: 0,
    writeErrors: [],
  });
  assert.equal(report.status, "invalid");
  assert.equal(report.checks.uniqueEventIds, false);
  assert.equal(report.checks.secretBearingKeysAbsent, false);
});
