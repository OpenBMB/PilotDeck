import assert from "node:assert/strict";
import test from "node:test";

import { buildLiteLLMContinuationRequest } from "../../../src/model/streaming/continuationRequest.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import { buildCachePlan } from "../../../src/context/cache/CachePlan.js";

test("continuation requests rebuild cache plans for the changed message sequence", () => {
  const original: CanonicalModelRequest = {
    provider: "modelbest",
    model: "claude-test",
    systemPrompt: "Stable system policy",
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
  assert.deepEqual(continuation.cacheBreakpoints, [4, 5, 6]);
  assert.deepEqual(continuation.cachePlan, buildCachePlan({ ...continuation, tools: [], enabled: true }, 1));
  const repeated = buildLiteLLMContinuationRequest(continuation, "longer partial");
  assert.equal(repeated.messages.length, 7);
  assert.deepEqual(repeated.cacheBreakpoints, [4, 5, 6]);
  assert.notEqual(repeated.cachePlan?.fingerprint, continuation.cachePlan?.fingerprint);
  assert.equal(repeated.messages[5].content[0].type === "text" && repeated.messages[5].content[0].text, "longer partial");
  assert.deepEqual(original.cacheBreakpoints, [2, 3, 4]);
  assert.equal(original.cachePlan?.fingerprint, "original");
});

test("continuations without cache opt-in remain unmarked; legacy markers are rebuilt", () => {
  const original: CanonicalModelRequest = { provider: "fixture", model: "model", messages: [
    { role: "user", content: [{ type: "text", text: "task" }] },
  ] };
  const plain = buildLiteLLMContinuationRequest(original, "partial");
  assert.equal(plain.cachePlan, undefined);
  assert.equal(plain.cacheBreakpoints, undefined);
  const legacy = buildLiteLLMContinuationRequest({ ...original, cacheBreakpoints: [0] }, "partial");
  assert.equal(legacy.cachePlan, undefined);
  assert.deepEqual(legacy.cacheBreakpoints, [0, 1, 2]);
});

test("continuations preserve explicit system/tool cache policy and disabled message caching", () => {
  const original: CanonicalModelRequest = { provider: "fixture", model: "model", systemPrompt: "policy",
    messages: [{ role: "user", content: [{ type: "text", text: "task" }] }],
    cachePlan: { system: false, tools: true, messages: [], fingerprint: "fixture", generation: 7 },
  };
  const next = buildLiteLLMContinuationRequest(original, "partial");
  assert.equal(next.cachePlan?.system, false);
  assert.equal(next.cachePlan?.tools, true);
  assert.deepEqual(next.cachePlan?.messages, []);
  assert.equal(next.cachePlan?.generation, 7);
});
