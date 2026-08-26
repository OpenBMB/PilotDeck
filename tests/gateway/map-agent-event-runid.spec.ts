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
