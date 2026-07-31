import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelEvent } from "../../../src/model/protocol/canonical.js";
import {
  createAnthropicStreamState,
  normalizeAnthropicStreamEvent,
} from "../../../src/model/providers/anthropic/stream.js";
import {
  createGoogleStreamState,
  normalizeGoogleStreamEvent,
} from "../../../src/model/providers/google/stream.js";
import {
  createOpenAIResponsesStreamState,
  normalizeOpenAIResponsesStreamEvent,
} from "../../../src/model/providers/openai-responses/stream.js";
import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
} from "../../../src/model/providers/openai/stream.js";

type ThinkingDelta = Extract<CanonicalModelEvent, { type: "thinking_delta" }>;

function thinkingDeltas(events: CanonicalModelEvent[]): ThinkingDelta[] {
  return events.filter((event): event is ThinkingDelta => event.type === "thinking_delta");
}

test("anthropic stream keeps one thinking identity per native content block", () => {
  const state = createAnthropicStreamState();
  normalizeAnthropicStreamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", id: "anthropic-native-block" },
  }, state);

  const deltas = thinkingDeltas([
    ...normalizeAnthropicStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Inspect " },
    }, state),
    ...normalizeAnthropicStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "the state" },
    }, state),
  ]);

  assert.equal(deltas.length, 2);
  assert.equal(deltas[0]?.thinkingBlockId, "anthropic-native-block");
  assert.equal(deltas[1]?.thinkingBlockId, "anthropic-native-block");
  assert.equal(deltas[0]?.thinkingBlockSeq, 0);
  assert.equal(deltas[1]?.thinkingBlockSeq, 0);
});

test("openai think-tag stream reuses identity within a block and advances after close", () => {
  const state = createOpenAIStreamState();
  const deltas = thinkingDeltas([
    ...normalizeOpenAIStreamEvent({
      choices: [{ index: 0, delta: { content: "<think>Plan " } }],
    }, state),
    ...normalizeOpenAIStreamEvent({
      choices: [{ index: 0, delta: { content: "A</think><think>Plan B</think>" } }],
    }, state),
  ]);

  assert.deepEqual(deltas.map((event) => event.text), ["Plan ", "A", "Plan B"]);
  assert.equal(deltas[0]?.thinkingBlockId, deltas[1]?.thinkingBlockId);
  assert.equal(deltas[0]?.thinkingBlockSeq, deltas[1]?.thinkingBlockSeq);
  assert.notEqual(deltas[1]?.thinkingBlockId, deltas[2]?.thinkingBlockId);
  assert.notEqual(deltas[1]?.thinkingBlockSeq, deltas[2]?.thinkingBlockSeq);
});

test("openai think-tag stream keeps repeated-prefix raw deltas", () => {
  const state = createOpenAIStreamState();
  const deltas = thinkingDeltas([
    ...normalizeOpenAIStreamEvent({
      choices: [{ index: 0, delta: { content: "<think>ha" } }],
    }, state),
    ...normalizeOpenAIStreamEvent({
      choices: [{ index: 0, delta: { content: "ha</think>" } }],
    }, state),
  ]);

  assert.deepEqual(deltas.map((event) => event.text), ["ha", "ha"]);
  assert.equal(new Set(deltas.map((event) => event.thinkingBlockId)).size, 1);
  assert.equal(new Set(deltas.map((event) => event.thinkingBlockSeq)).size, 1);
});

test("openai reasoning_content snapshots emit only the new delta for one block", () => {
  const state = createOpenAIStreamState();
  const deltas = thinkingDeltas([
    ...normalizeOpenAIStreamEvent({
      choices: [{ index: 0, delta: { reasoning_content: "Plan" } }],
    }, state),
    ...normalizeOpenAIStreamEvent({
      choices: [{ index: 0, delta: { reasoning_content: "Plan now" } }],
    }, state),
    ...normalizeOpenAIStreamEvent({
      choices: [{ index: 0, delta: { reasoning_content: " done" } }],
    }, state),
  ]);

  assert.deepEqual(deltas.map((event) => event.text), ["Plan", " now", " done"]);
  assert.deepEqual(deltas.map((event) => event.reasoningContent), ["Plan", " now", " done"]);
  assert.equal(new Set(deltas.map((event) => event.thinkingBlockId)).size, 1);
});

test("openai responses stream maps item ids to stable thinking block ids", () => {
  const state = createOpenAIResponsesStreamState();
  const deltas = thinkingDeltas([
    ...normalizeOpenAIResponsesStreamEvent({
      type: "response.reasoning_text.delta",
      item_id: "rs_123",
      output_index: 0,
      delta: "Check ",
    }, state),
    ...normalizeOpenAIResponsesStreamEvent({
      type: "response.reasoning_text.delta",
      item_id: "rs_123",
      output_index: 0,
      delta: "again",
    }, state),
  ]);

  assert.equal(deltas.length, 2);
  assert.equal(deltas[0]?.thinkingBlockId, "rs_123");
  assert.equal(deltas[1]?.thinkingBlockId, "rs_123");
  assert.equal(deltas[0]?.thinkingBlockSeq, deltas[1]?.thinkingBlockSeq);
});

test("openai responses stream falls back to output index when item id is absent", () => {
  const state = createOpenAIResponsesStreamState();
  const first = thinkingDeltas(normalizeOpenAIResponsesStreamEvent({
    type: "response.reasoning_text.delta",
    output_index: 0,
    delta: "First block",
  }, state))[0];
  const second = thinkingDeltas(normalizeOpenAIResponsesStreamEvent({
    type: "response.reasoning_text.delta",
    output_index: 1,
    delta: "Second block",
  }, state))[0];

  assert.equal(first?.thinkingBlockSeq, 0);
  assert.equal(second?.thinkingBlockSeq, 1);
  assert.notEqual(first?.thinkingBlockId, second?.thinkingBlockId);
});

test("google thought parts keep a stable synthetic thinking identity", () => {
  const state = createGoogleStreamState();
  const deltas = thinkingDeltas([
    ...normalizeGoogleStreamEvent({
      candidates: [{
        content: {
          parts: [{ text: "Inspect ", thought: true, thoughtSignature: "sig-google" }],
        },
      }],
    }, state),
    ...normalizeGoogleStreamEvent({
      candidates: [{
        content: {
          parts: [{ text: "state", thought: true }],
        },
      }],
    }, state),
  ]);

  assert.equal(deltas.length, 2);
  assert.equal(deltas[0]?.thinkingBlockId, deltas[1]?.thinkingBlockId);
  assert.equal(deltas[0]?.thinkingBlockSeq, deltas[1]?.thinkingBlockSeq);
  assert.equal(deltas[0]?.signature, "sig-google");
});
