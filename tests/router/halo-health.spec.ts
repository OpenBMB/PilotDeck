import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelError, ModelRuntime } from "../../src/model/index.js";
import {
  classifyRecoverySignal,
  providerFailureDomain,
  ProviderHealthTracker,
} from "../../src/router/health/ProviderHealthTracker.js";

const error = (code: string, status?: number): CanonicalModelError => ({
  provider: "p", protocol: "openai", code, status, message: code, retryable: status === 429 || (status ?? 0) >= 500,
});

test("HALO separates service, credential, task, cancellation and unknown signals", () => {
  assert.equal(classifyRecoverySignal(error("rate_limit_error", 429)), "service");
  assert.equal(classifyRecoverySignal(error("server_error", 503)), "service");
  assert.equal(classifyRecoverySignal(error("auth_error", 401)), "credential");
  assert.equal(classifyRecoverySignal(error("invalid_tool_arguments")), "task");
  assert.equal(classifyRecoverySignal(error("aborted")), "cancelled");
  assert.equal(classifyRecoverySignal(error("new_provider_error")), "unknown");
});

test("failure domain merges aliases without retaining credentials or query strings", () => {
  const runtime = {
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://user:secret@API.EXAMPLE.test/v1/?tenant=secret",
  } as unknown as ModelRuntime;
  const a = providerFailureDomain(runtime, { id: "a/m", provider: "a", model: "m" });
  const b = providerFailureDomain(runtime, { id: "b/m", provider: "b", model: "m" });
  assert.equal(a, b);
  assert.equal(a, "openai|https://api.example.test/v1");
  assert.doesNotMatch(a, /secret|tenant|user/);
});

test("health memory is bounded, expires, smooths cold samples and permits one half-open probe", () => {
  let now = 0;
  const health = new ProviderHealthTracker({
    now: () => now, capacity: 2, recordTtlMs: 100, openDurationMs: 10,
    maxOpenDurationMs: 20, degradeThreshold: 1, openThreshold: 1,
  });
  assert.equal(health.getSuccessRate("cold"), 0.5);
  health.recordFailure("a");
  assert.equal(health.getSuccessRate("a"), 0.4);
  assert.equal(health.getState("a"), "open");
  now = 10;
  assert.equal(health.getState("a"), "half_open");
  assert.equal(health.tryAcquire("a"), true);
  assert.equal(health.tryAcquire("a"), false);
  health.recordSuccess("a", 20);
  assert.equal(health.getState("a"), "healthy");
  health.recordSuccess("b");
  health.recordSuccess("c");
  assert.equal(health.snapshot().size, 2);
  now = 200;
  health.recordSuccess("d");
  assert.deepEqual([...health.snapshot().keys()], ["d"]);
});
