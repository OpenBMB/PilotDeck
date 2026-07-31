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

test("mapAgentEvent forwards thinking block identity fields", () => {
  const events = mapAgentEvent({
    type: "model_event",
    sessionId: "session-1",
    turnId: "turn-1",
    event: {
      type: "thinking_delta",
      text: "inspect",
      reasoningContent: "native inspect",
      thinkingBlockId: "block-1",
      thinkingBlockSeq: 7,
    },
  } as unknown as AgentEvent, "run-1");

  assert.deepEqual(events[0], {
    type: "assistant_thinking_delta",
    text: "inspect",
    reasoningContent: "native inspect",
    thinkingBlockId: "block-1",
    thinkingBlockSeq: 7,
    runId: "run-1",
  });
});
