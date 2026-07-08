import assert from "node:assert/strict";
import test from "node:test";

import { planFallback } from "../../src/router/fallback/runFallbackChain.js";
import type { RouterFallbackConfig, RouterModelRef } from "../../src/router/config/schema.js";

function ref(index: number): RouterModelRef {
  return { id: `p${index}/m${index}`, provider: `p${index}`, model: `m${index}` };
}

test("router fallback caps default attempts at LiteLLM maxFallbacks", () => {
  const fallback: RouterFallbackConfig = {
    default: Array.from({ length: 10 }, (_, index) => ref(index)),
  };
  const plan = planFallback(fallback, "default");
  assert.equal(plan.attempts.length, 5);
  assert.deepEqual(plan.attempts.map((attempt) => attempt.id), ["p0/m0", "p1/m1", "p2/m2", "p3/m3", "p4/m4"]);
});

test("router fallback honors explicit maxFallbacks override", () => {
  const fallback: RouterFallbackConfig = {
    maxFallbacks: 2,
    default: Array.from({ length: 4 }, (_, index) => ref(index)),
  };
  const plan = planFallback(fallback, "explicit");
  assert.equal(plan.attempts.length, 2);
});
