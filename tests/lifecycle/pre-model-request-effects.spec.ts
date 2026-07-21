import test from "node:test";
import assert from "node:assert/strict";
import { applyPreModelRequestEffects } from "../../src/lifecycle/runtime/applyPreModelRequestEffects.js";
import type { LifecycleDispatchResult } from "../../src/lifecycle/protocol/payloads.js";
import type { CanonicalModelRequest } from "../../src/model/index.js";

const request: CanonicalModelRequest = {
  provider: "base-provider",
  model: "base-model",
  messages: [{ role: "user", content: [{ type: "text", text: "original" }] }],
  systemPrompt: "base system",
  maxOutputTokens: 1000,
};

function result(overrides: Partial<LifecycleDispatchResult>): LifecycleDispatchResult {
  return {
    effects: [],
    messages: [],
    events: [],
    blockingErrors: [],
    nonBlockingErrors: [],
    ...overrides,
  };
}

test("applies context, system messages, and restricted model request patches", () => {
  const transformed = applyPreModelRequestEffects(request, result({
    messages: [{ role: "user", content: [{ type: "text", text: "dynamic" }], metadata: { synthetic: true } }],
    effects: [
      { type: "system_message", content: "legal system addendum" },
      { type: "model_request_patch", patch: { model: "review-model", maxOutputTokens: 2000, metadata: { source: "legal" } } },
    ],
  }));

  assert.equal(transformed.type, "ready");
  if (transformed.type !== "ready") return;
  assert.equal(transformed.request.model, "review-model");
  assert.equal(transformed.request.maxOutputTokens, 2000);
  assert.equal(transformed.request.messages.length, 2);
  assert.equal(transformed.request.systemPrompt, "base system\n\nlegal system addendum");
  assert.deepEqual(transformed.request.metadata, { source: "legal" });
});

test("blocks before any request mutation is used", () => {
  const transformed = applyPreModelRequestEffects(request, result({
    effects: [
      { type: "model_request_patch", patch: { model: "unused" } },
      { type: "block", reason: "validator rejected request" },
    ],
  }));
  assert.deepEqual(transformed, { type: "blocked", reason: "validator rejected request", stopReason: undefined });
});
