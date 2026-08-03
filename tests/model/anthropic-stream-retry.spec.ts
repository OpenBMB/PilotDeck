import test from "node:test";
import assert from "node:assert/strict";
import { createAnthropicStreamState, normalizeAnthropicStreamEvent } from "../../src/model/providers/anthropic/stream.js";

test("Anthropic-compatible terminated SSE errors remain retryable", () => {
  const events = normalizeAnthropicStreamEvent({
    type: "error",
    error: { type: "provider_error", message: "terminated" },
  }, createAnthropicStreamState());

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event?.type, "error");
  if (event?.type !== "error") return;
  assert.equal(event.error.code, "connection_reset");
  assert.equal(event.error.retryable, true);
});
