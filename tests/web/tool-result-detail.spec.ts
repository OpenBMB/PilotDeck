import test from "node:test";
import assert from "node:assert/strict";

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

test("web reducer merges persisted tool result detail path into existing tool result", () => {
  const options = reducerOptions();
  let state = createWebMessageReducerState();
  state = applyWebGatewayEvent(state, {
    type: "tool_call_started",
    toolCallId: "call-large",
    name: "bash",
    argsPreview: "{\"command\":\"cat large.log\"}",
  }, options);
  state = applyWebGatewayEvent(state, {
    type: "tool_call_finished",
    toolCallId: "call-large",
    ok: true,
    resultPreview: "large preview",
  }, options);
  state = applyWebGatewayEvent(state, {
    type: "tool_result_detail_available",
    toolCallId: "call-large",
    resultPath: "/tmp/pilotdeck/tool-result.txt",
    fullText: "x".repeat(100000),
  }, options);

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.kind, "tool_result");
  assert.equal(state.messages[0]?.text, "large preview");
  assert.equal(state.messages[0]?.resultPath, "/tmp/pilotdeck/tool-result.txt");
  assert.equal("fullText" in state.messages[0]!, false);
});

test("web reducer bounds huge live tool result previews", () => {
  const options = reducerOptions();
  let state = createWebMessageReducerState();
  state = applyWebGatewayEvent(state, {
    type: "tool_call_finished",
    toolCallId: "call-huge",
    ok: true,
    resultPreview: `head\n${"x".repeat(50000)}\ntail`,
  }, options);

  assert.equal(state.messages.length, 1);
  const text = state.messages[0]?.text ?? "";
  assert.ok(text.length < 22_000);
  assert.match(text, /UI preview truncated/);
  assert.match(text, /head/);
  assert.match(text, /tail/);
});
