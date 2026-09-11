import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";

test("mapAgentEvent propagates runId to streaming lifecycle boundaries", () => {
  const runId = "run-1";

  const accepted = mapAgentEvent({
    type: "input_accepted",
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
  }, runId);
  assert.deepEqual(accepted, [{ type: "input_accepted", runId }]);

  const permissionDenied = mapAgentEvent({
    type: "permission_denied",
    sessionId: "session-1",
    turnId: "turn-1",
    toolName: "write_file",
    reason: "Writes are disabled for this request.",
  }, runId);
  assert.deepEqual(permissionDenied, [{
    type: "permission_denied",
    toolName: "write_file",
    reason: "Writes are disabled for this request.",
    runId,
  }]);

  const unapplied = mapAgentEvent({
    type: "steer_unapplied",
    sessionId: "session-1",
    turnId: "turn-1",
    itemId: "queue-1",
    reason: "turn_ended",
  }, runId);
  assert.deepEqual(unapplied, [{
    type: "steer_unapplied",
    itemId: "queue-1",
    reason: "turn_ended",
    runId,
  }]);

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

  const compactCompleted = mapAgentEvent({
    type: "compact_completed",
    sessionId: "session-1",
    turnId: "turn-1",
    compactionId: "compact-1",
    trigger: "reactive",
    status: "success",
    preTokens: 120,
    postTokens: 40,
    messagesSummarized: 3,
  }, runId);
  assert.deepEqual(compactCompleted, [{
    type: "agent_status",
    event: "compact_completed",
    detail: {
      compactionId: "compact-1",
      trigger: "reactive",
      status: "success",
      preTokens: 120,
      postTokens: 40,
      messagesSummarized: 3,
    },
    runId,
  }]);
});

test("mapAgentEvent preserves an aborted subagent completion", () => {
  const [completed] = mapAgentEvent({
    type: "subagent_completed",
    sessionId: "session-1",
    turnId: "turn-1",
    subagentId: "subagent-1",
    subagentType: "explore",
    success: false,
    aborted: true,
    durationMs: 10,
  }, "run-1");

  assert.equal(completed?.type, "agent_status");
  assert.equal(completed?.runId, "run-1");
  assert.deepEqual(completed?.type === "agent_status" ? completed.detail : undefined, {
    subagentId: "subagent-1",
    subagentType: "explore",
    success: false,
    aborted: true,
    durationMs: 10,
  });
});

test("mapAgentEvent exposes child text only when the SDK stream opts in", () => {
  const event: AgentEvent = {
    type: "subagent_model_event",
    sessionId: "session-1",
    turnId: "turn-1",
    subagentId: "subagent-1",
    subagentType: "researcher",
    event: { type: "text_delta", text: "Child result" },
  };

  assert.deepEqual(mapAgentEvent(event, "run-1"), [{
    type: "agent_status",
    event: "subagent_text_delta",
    detail: {
      subagentId: "subagent-1",
      subagentType: "researcher",
      text: "Child result",
    },
    runId: "run-1",
  }]);

  assert.deepEqual(mapAgentEvent(event, "run-1", { forwardSubagentText: true }), [{
    type: "subagent_text_delta",
    subagentId: "subagent-1",
    subagentType: "researcher",
    text: "Child result",
    runId: "run-1",
  }]);
});

test("mapAgentEvent forwards native context-budget diagnostics without changing legacy fields", () => {
  const [mapped] = mapAgentEvent({
    type: "context_budget",
    sessionId: "session-1",
    turnId: "turn-1",
    snapshot: {
      tokens: 120,
      displayTokens: 118,
      localEstimateTokens: 130,
      estimateSource: "usage",
      usageTokens: 120,
      totalContextTokens: 1_000,
      maxContextTokens: 900,
      effectiveContextTokens: 900,
      maxOutputTokens: 100,
      warningRatio: 0.8,
      blockingRatio: 0.9,
      ratio: 120 / 900,
      state: "ok",
      source: "provider",
      exact: true,
      reservedOutputTokens: 100,
      breakdown: {
        source: "local_estimate",
        total: 130,
        system: 30,
        tools: 40,
        messages: 40,
        mcp: 10,
        memory: 10,
      },
    },
  }, "run-1");

  assert.deepEqual(mapped, {
    type: "context_budget",
    used: 120,
    displayUsed: 120,
    localEstimateTokens: 130,
    displayTokens: 118,
    estimateSource: "usage",
    usageTokens: 120,
    total: 1_000,
    totalContextTokens: 1_000,
    maxContextTokens: 900,
    effectiveTotal: 900,
    effectiveContextTokens: 900,
    maxOutputTokens: 100,
    reservedOutputTokens: 100,
    warningRatio: 0.8,
    blockingRatio: 0.9,
    ratio: 120 / 900,
    state: "ok",
    source: "provider",
    exact: true,
    breakdown: {
      source: "local_estimate",
      total: 130,
      system: 30,
      tools: 40,
      messages: 40,
      mcp: 10,
      memory: 10,
    },
    runId: "run-1",
  });
});

test("mapAgentEvent projects transient tool progress with the active run id", () => {
  const [mapped] = mapAgentEvent({
    type: "tool_progress",
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    toolName: "bash",
    message: "stdout: 12 bytes",
    metadata: { stream: "stdout", byteCount: 12 },
    createdAt: "2026-09-09T00:00:00.000Z",
  }, "run-1");

  assert.deepEqual(mapped, {
    type: "tool_progress",
    toolCallId: "call-1",
    toolName: "bash",
    message: "stdout: 12 bytes",
    metadata: { stream: "stdout", byteCount: 12 },
    createdAt: "2026-09-09T00:00:00.000Z",
    runId: "run-1",
  });
});
