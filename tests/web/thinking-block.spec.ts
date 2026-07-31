import assert from "node:assert/strict";
import test from "node:test";

import { applyWebGatewayEvent, createWebMessageReducerState } from "../../src/web/client/webMessage.js";

function reducerOptions() {
  let id = 0;
  return {
    sessionKey: "s1",
    projectKey: "p1",
    now: () => new Date("2026-07-09T00:00:00.000Z"),
    newId: () => `msg-${++id}`,
  };
}

test("web reducer appends deltas for the same thinking block into one message", () => {
  const options = reducerOptions();
  let state = createWebMessageReducerState();

  state = applyWebGatewayEvent(state, {
    type: "assistant_thinking_delta",
    text: "Inspect ",
    runId: "run-1",
    thinkingBlockId: "block-a",
    thinkingBlockSeq: 3,
  }, options);
  state = applyWebGatewayEvent(state, {
    type: "assistant_thinking_delta",
    text: "state",
    runId: "run-1",
    thinkingBlockId: "block-a",
    thinkingBlockSeq: 3,
  }, options);

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.kind, "thinking");
  assert.equal(state.messages[0]?.text, "Inspect state");
  assert.equal(state.messages[0]?.thinkingBlockId, "block-a");
  assert.equal(state.messages[0]?.thinkingBlockSeq, 3);
});

test("web reducer creates a new thinking message when block id changes", () => {
  const options = reducerOptions();
  let state = createWebMessageReducerState();

  state = applyWebGatewayEvent(state, {
    type: "assistant_thinking_delta",
    text: "First",
    runId: "run-1",
    thinkingBlockId: "block-a",
  }, options);
  state = applyWebGatewayEvent(state, {
    type: "assistant_thinking_delta",
    text: "Second",
    runId: "run-1",
    thinkingBlockId: "block-b",
  }, options);

  assert.deepEqual(state.messages.map((message) => message.text), ["First", "Second"]);
});

test("web reducer uses thinkingBlockSeq as the fallback block key", () => {
  const options = reducerOptions();
  let state = createWebMessageReducerState();

  state = applyWebGatewayEvent(state, {
    type: "assistant_thinking_delta",
    text: "A",
    runId: "run-1",
    thinkingBlockSeq: 1,
  }, options);
  state = applyWebGatewayEvent(state, {
    type: "assistant_thinking_delta",
    text: "B",
    runId: "run-1",
    thinkingBlockSeq: 2,
  }, options);

  assert.deepEqual(state.messages.map((message) => message.text), ["A", "B"]);
});

test("web reducer preserves legacy merging when thinking block fields are absent", () => {
  const options = reducerOptions();
  let state = createWebMessageReducerState();

  state = applyWebGatewayEvent(state, {
    type: "assistant_thinking_delta",
    text: "Legacy ",
    runId: "run-1",
  }, options);
  state = applyWebGatewayEvent(state, {
    type: "assistant_thinking_delta",
    text: "block",
    runId: "run-1",
  }, options);
  state = applyWebGatewayEvent(state, {
    type: "tool_call_started",
    toolCallId: "call-1",
    name: "bash",
    runId: "run-1",
  }, options);
  state = applyWebGatewayEvent(state, {
    type: "assistant_thinking_delta",
    text: "Next",
    runId: "run-1",
  }, options);

  assert.deepEqual(
    state.messages.filter((message) => message.kind === "thinking").map((message) => message.text),
    ["Legacy block", "Next"],
  );
});
