import assert from "node:assert/strict";
import test from "node:test";

import { buildLiteLLMContinuationRequest } from "../../../src/model/streaming/continuationRequest.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";

test("continuation requests do not reuse cache indices from the original message sequence", () => {
  const original: CanonicalModelRequest = {
    provider: "modelbest",
    model: "claude-test",
    messages: [
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "text", text: "three" }] },
      { role: "assistant", content: [{ type: "text", text: "four" }] },
      { role: "user", content: [{ type: "text", text: "five" }] },
    ],
    cacheBreakpoints: [2, 3, 4],
    cachePlan: {
      provider: "modelbest",
      model: "claude-test",
      system: true,
      tools: false,
      messages: [2, 3, 4],
      fingerprint: "original",
      generation: 1,
    },
  };

  const continuation = buildLiteLLMContinuationRequest(original, "partial");

  assert.equal(continuation.messages.length, 7);
  assert.equal(continuation.cacheBreakpoints, undefined);
  assert.equal(continuation.cachePlan, undefined);
});
