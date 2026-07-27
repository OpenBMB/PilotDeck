import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";

test("mapAgentEvent propagates runId to streaming lifecycle boundaries", () => {
  const runId = "run-1";

  const toolStarted = mapAgentEvent({
    type: "tool_calls_detected",
    sessionId: "session-1",
    turnId: "turn-1",
    calls: [{ id: "call-1", name: "bash", input: { command: "pwd" } }],
  } as unknown as AgentEvent, runId);
  assert.equal(toolStarted[0]?.type, "tool_call_started");
  assert.equal(toolStarted[0]?.runId, runId);

  const completed = mapAgentEvent({
    type: "turn_completed",
    sessionId: "session-1",
    turnId: "turn-1",
    result: {
      stopReason: "completed",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  } as unknown as AgentEvent, runId);
  assert.equal(completed[0]?.type, "turn_completed");
  assert.equal(completed[0]?.runId, runId);

  const failed = mapAgentEvent({
    type: "turn_failed",
    sessionId: "session-1",
    turnId: "turn-1",
    error: { code: "model_error", message: "boom" },
  } as unknown as AgentEvent, runId);
  assert.equal(failed[0]?.type, "error");
  assert.equal(failed[0]?.runId, runId);
});

test("mapAgentEvent projects every convergence ordinal", () => {
  const [status] = mapAgentEvent({
    type: "progress_lease_evaluated",
    sessionId: "session-1",
    turnId: "turn-1",
    scope: "domain-validation",
    phase: "coverage",
    blockingCode: "missing_rows",
    remainingCount: 4,
    progressOrdinal: 8,
    repairOrdinal: 3,
    repairPreparationOrdinal: 2,
    handoffOrdinal: 1,
    stagnantObservations: 1,
    decision: "handoff_grace",
    forceBoundaryNext: true,
  }, "run-1");

  assert.equal(status?.type, "agent_status");
  if (status?.type !== "agent_status") return;
  assert.deepEqual(status.detail, {
    scope: "domain-validation",
    phase: "coverage",
    blockingCode: "missing_rows",
    remainingCount: 4,
    progressOrdinal: 8,
    repairOrdinal: 3,
    repairPreparationOrdinal: 2,
    handoffOrdinal: 1,
    stagnantObservations: 1,
    decision: "handoff_grace",
    forceBoundaryNext: true,
    reason: undefined,
  });
});

test("mapAgentEvent exposes a post-tool boundary deferral without domain payload", () => {
  const [status] = mapAgentEvent({
    type: "progress_boundary_deferred",
    sessionId: "session-1",
    turnId: "turn-1",
    scopes: ["domain-validation"],
  }, "run-1");

  assert.equal(status?.type, "agent_status");
  if (status?.type !== "agent_status") return;
  assert.equal(status.event, "progress_boundary_deferred");
  assert.deepEqual(status.detail, { scopes: ["domain-validation"] });
});

test("mapAgentEvent exposes the bounded preview evaluation reason", () => {
  const [status] = mapAgentEvent({
    type: "progress_boundary_preview_evaluated",
    sessionId: "session-1",
    turnId: "turn-1",
    scope: "domain-validation",
    decision: "required",
    reason: "preview_not_renewable",
  }, "run-1");

  assert.equal(status?.type, "agent_status");
  if (status?.type !== "agent_status") return;
  assert.equal(status.event, "progress_boundary_preview_evaluated");
  assert.deepEqual(status.detail, {
    scope: "domain-validation",
    decision: "required",
    reason: "preview_not_renewable",
  });
});
