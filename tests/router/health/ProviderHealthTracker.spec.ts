import assert from "node:assert/strict";
import test from "node:test";

import { ProviderHealthTracker } from "../../../src/router/health/ProviderHealthTracker.js";

const advance = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

test("ProviderHealthTracker: defaults to healthy for unknown providers", () => {
  const tracker = new ProviderHealthTracker();
  assert.equal(tracker.getState("unknown"), "healthy");
  assert.equal(tracker.shouldSkip("unknown"), false);
  assert.equal(tracker.isAvailable("unknown"), true);
  assert.equal(tracker.getSuccessRate("unknown"), 1);
});

test("ProviderHealthTracker: degrades after degradeThreshold consecutive failures", () => {
  const tracker = new ProviderHealthTracker({ degradeThreshold: 3, openThreshold: 10 });
  for (let i = 0; i < 3; i++) {
    tracker.recordFailure("p");
  }
  assert.equal(tracker.getState("p"), "degraded");
  assert.equal(tracker.shouldSkip("p"), false, "degraded providers still receive traffic");
});

test("ProviderHealthTracker: opens after openThreshold consecutive failures", () => {
  const tracker = new ProviderHealthTracker({ degradeThreshold: 2, openThreshold: 5 });
  for (let i = 0; i < 5; i++) {
    tracker.recordFailure("p");
  }
  assert.equal(tracker.getState("p"), "open");
  assert.equal(tracker.shouldSkip("p"), true);
  assert.equal(tracker.isAvailable("p"), false);
});

test("ProviderHealthTracker: open → half_open after openDurationMs", async () => {
  const tracker = new ProviderHealthTracker({
    degradeThreshold: 1,
    openThreshold: 2,
    openDurationMs: 25,
  });
  tracker.recordFailure("p");
  tracker.recordFailure("p");
  assert.equal(tracker.getState("p"), "open");
  await advance(40);
  // The first call to getState should auto-promote `open` → `half_open`.
  assert.equal(tracker.getState("p"), "half_open");
  assert.equal(tracker.shouldSkip("p"), false, "half_open permits one probe request");
});

test("ProviderHealthTracker: a probe success from half_open closes the circuit", async () => {
  const tracker = new ProviderHealthTracker({
    degradeThreshold: 1,
    openThreshold: 2,
    openDurationMs: 10,
  });
  tracker.recordFailure("p");
  tracker.recordFailure("p");
  await advance(15);
  assert.equal(tracker.getState("p"), "half_open");
  tracker.recordSuccess("p");
  assert.equal(tracker.getState("p"), "healthy");
  assert.equal(tracker.shouldSkip("p"), false);
});

test("ProviderHealthTracker: a probe failure re-opens the circuit", async () => {
  const tracker = new ProviderHealthTracker({
    degradeThreshold: 1,
    openThreshold: 2,
    openDurationMs: 10,
  });
  tracker.recordFailure("p");
  tracker.recordFailure("p");
  await advance(15);
  assert.equal(tracker.getState("p"), "half_open");
  tracker.recordFailure("p");
  assert.equal(tracker.getState("p"), "open");
  assert.equal(tracker.shouldSkip("p"), true);
});

test("ProviderHealthTracker: getSuccessRate is the trailing window ratio", () => {
  const tracker = new ProviderHealthTracker({ windowSize: 4 });
  tracker.recordSuccess("p");
  tracker.recordSuccess("p");
  tracker.recordFailure("p");
  tracker.recordFailure("p");
  assert.equal(tracker.getSuccessRate("p"), 0.5);
});

test("ProviderHealthTracker: snapshot returns every observed provider", () => {
  const tracker = new ProviderHealthTracker();
  tracker.recordSuccess("a");
  tracker.recordFailure("b");
  const snap = tracker.snapshot();
  assert.ok(snap.has("a"));
  assert.ok(snap.has("b"));
  assert.equal(snap.get("a")!.state, "healthy");
  assert.equal(snap.get("b")!.state, "healthy");
  assert.equal(snap.get("b")!.consecutiveFailures, 1);
});

test("ProviderHealthTracker: reset clears a single provider; resetAll clears all", () => {
  const tracker = new ProviderHealthTracker();
  tracker.recordFailure("a");
  tracker.recordFailure("b");
  tracker.reset("a");
  assert.equal(tracker.getState("a"), "healthy");
  assert.equal(tracker.getState("b"), "healthy");
  assert.equal(tracker.getSuccessRate("a"), 1);
  // recordFailure again on b to confirm it still works
  tracker.recordFailure("b");
  assert.equal(tracker.getState("b"), "healthy");
  tracker.resetAll();
  tracker.recordFailure("b");
  assert.equal(tracker.getState("b"), "healthy");
});
