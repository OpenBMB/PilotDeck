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
  // Caller invokes shouldSkip / getState to decide whether to send the
  // probe request. That call auto-promotes `open` → `half_open` once
  // `openDurationMs` has elapsed.
  assert.equal(tracker.getState("p"), "half_open");
  tracker.recordFailure("p");
  assert.equal(tracker.getState("p"), "open");
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

// --- Defensive hardening tests (follow-up PR) ---

test("ProviderHealthTracker: recordFailure while state is open refreshes openedAt so getState does not immediately auto-promote", async () => {
  // Regression: under the prior implementation, when consecutive failures
  // re-crossed the open threshold while the circuit was already `open`, the
  // inner `if (rec.state !== 'open')` guard made the assignment a no-op,
  // so `openedAt` was never refreshed. The next `getState` call would then
  // immediately auto-promote `open → half_open` (because Date.now() -
  // openedAt >= openDurationMs) even though we had just observed another
  // failure.
  const tracker = new ProviderHealthTracker({
    degradeThreshold: 1,
    openThreshold: 2,
    openDurationMs: 100,
  });
  tracker.recordFailure("p");
  tracker.recordFailure("p");
  // State should be `open` with openedAt = now-ish. Wait past
  // openDurationMs and call getState once: state goes to `half_open`,
  // openedAt is left untouched.
  await advance(150);
  assert.equal(tracker.getState("p"), "half_open");

  // Simulate a buggy caller that invokes recordFailure without first
  // checking shouldSkip: state is still `half_open`, so the existing
  // half_open→open branch fires correctly (this branch already handled
  // openedAt). To exercise the new path, put the provider back into `open`
  // and force the consecutive-failure counter past the threshold again.
  tracker.recordFailure("p"); // half_open → open, openedAt = now
  assert.equal(tracker.getState("p"), "open");
  // Wait past openDurationMs so the next getState *would* auto-promote
  // based on the timestamp.
  await advance(150);
  // Drive the consecutive-failure counter over the threshold again while
  // state is `open` (state doesn't change, but the new code refreshes
  // openedAt):
  for (let i = 0; i < 2; i++) tracker.recordFailure("p");
  // Now state must still be `open`; the next getState must NOT immediately
  // auto-promote because openedAt was just refreshed.
  assert.equal(tracker.getState("p"), "open", "getState must not immediately auto-promote after recordFailure refreshes openedAt");
});

test("ProviderHealthTracker: recordSuccess clears openedAt so a later getState cannot spuriously auto-promote", async () => {
  // Regression: under the prior implementation, an `open → healthy` transition
  // via recordSuccess left `openedAt` set. Any subsequent call sequence that
  // drove a future `recordFailure` followed by `getState` could see
  // "Date.now() - openedAt >= openDurationMs" using the *stale* baseline and
  // auto-promote `open → half_open` even though we had just transitioned to
  // `healthy`.
  const tracker = new ProviderHealthTracker({
    degradeThreshold: 1,
    openThreshold: 2,
    openDurationMs: 10,
  });
  tracker.recordFailure("p");
  tracker.recordFailure("p");
  await advance(15);
  // getState promotes `open → half_open`.
  assert.equal(tracker.getState("p"), "half_open");
  tracker.recordSuccess("p");
  assert.equal(tracker.getState("p"), "healthy");
  // No getState call between now and the next recordFailure, but
  // openedAt must have been reset. We can't read openedAt directly (it's
  // private), but the proof is: if a future recordFailure puts us back to
  // open with a *fresh* openedAt, the next getState must NOT immediately
  // auto-promote. Test that.
  // First, accumulate more failures to push past the threshold.
  for (let i = 0; i < 2; i++) tracker.recordFailure("p");
  assert.equal(tracker.getState("p"), "open");
  // openedAt was just set by recordFailure. Wait past openDurationMs
  // without calling getState in between; the next getState is allowed to
  // auto-promote because the open is "real" and old.
  await advance(15);
  assert.equal(tracker.getState("p"), "half_open");
});
