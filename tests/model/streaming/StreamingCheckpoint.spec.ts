import assert from "node:assert/strict";
import test from "node:test";

import { StreamingCheckpointManager } from "../../../src/model/streaming/StreamingCheckpoint.js";

test("tool-call stream interruption retains only safe call metadata", () => {
  const checkpoint = new StreamingCheckpointManager();
  const secretArguments = '{"path":"deck.mjs","content":"do-not-retain-this-builder"}';

  checkpoint.onEvent({ type: "tool_call_start", id: "call-1", name: "write_file" });
  checkpoint.onEvent({ type: "tool_call_delta", id: "call-1", delta: secretArguments });

  assert.equal(checkpoint.canContinueText(), false);
  assert.deepEqual(checkpoint.interruption(), {
    phase: "tool_call",
    activeToolCalls: [{ id: "call-1", name: "write_file", argumentChars: secretArguments.length }],
  });
  assert.doesNotMatch(JSON.stringify(checkpoint.interruption()), /do-not-retain-this-builder/);
});

test("text and reasoning interruptions keep distinct recovery phases", () => {
  const text = new StreamingCheckpointManager();
  text.onEvent({ type: "text_delta", text: "partial answer" });
  assert.equal(text.canContinueText(), true);
  assert.deepEqual(text.interruption(), { phase: "text" });

  const reasoning = new StreamingCheckpointManager();
  reasoning.onEvent({ type: "thinking_delta", text: "private reasoning" });
  assert.equal(reasoning.canContinueText(), false);
  assert.deepEqual(reasoning.interruption(), { phase: "reasoning" });
});

test("text tool-call syntax cannot continue across a stream interruption", () => {
  const checkpoint = new StreamingCheckpointManager();
  checkpoint.onEvent({ type: "text_delta", text: '<tool_call>{"name":"write_file","arguments":{"path":"secret.mjs"' });

  assert.equal(checkpoint.canContinueText(), false);
});

test("reasoning makes an otherwise text-only stream ineligible for continuation", () => {
  const checkpoint = new StreamingCheckpointManager();
  checkpoint.onEvent({ type: "thinking_delta", text: "reasoning" });
  checkpoint.onEvent({ type: "text_delta", text: "partial answer" });

  assert.equal(checkpoint.canContinueText(), false);
  assert.deepEqual(checkpoint.interruption(), { phase: "text" });
});
