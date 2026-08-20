import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAIResponsesStreamState,
  normalizeOpenAIResponsesStreamEvent,
} from "../../../src/model/providers/openai-responses/stream.js";

test("response.failed produces a complete assistant lifecycle", () => {
  const raw = {
    type: "response.failed",
    response: {
      id: "resp-1",
      error: { code: "server_error", message: "provider failed" },
    },
  };
  const events = normalizeOpenAIResponsesStreamEvent(raw, createOpenAIResponsesStreamState());

  assert.deepEqual(events.map(event => event.type), [
    "message_start",
    "error",
    "message_end",
  ]);
  assert.equal(events[1]?.type === "error" && events[1].error.code, "server_error");
  assert.equal(events[2]?.type === "message_end" && events[2].finishReason, "error");
});

test("response.failed closes an already-started lifecycle exactly once", () => {
  const state = createOpenAIResponsesStreamState();
  assert.deepEqual(
    normalizeOpenAIResponsesStreamEvent({ type: "response.created", response: { id: "resp-1" } }, state)
      .map(event => event.type),
    ["message_start"],
  );

  const events = normalizeOpenAIResponsesStreamEvent({
    type: "response.failed",
    response: { id: "resp-1", error: { message: "failed" } },
  }, state);
  assert.deepEqual(events.map(event => event.type), ["error", "message_end"]);
});

test("transport error events do not invent a provider lifecycle boundary", () => {
  const events = normalizeOpenAIResponsesStreamEvent({
    type: "error",
    error: { code: "connection_reset", message: "socket closed" },
  }, createOpenAIResponsesStreamState());

  assert.deepEqual(events.map(event => event.type), ["error"]);
});
