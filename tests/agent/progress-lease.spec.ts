import test from "node:test";
import assert from "node:assert/strict";
import {
  ProgressLease,
  parseConvergenceReport,
  type ConvergenceReport,
  type ProgressBoundaryOutcome,
} from "../../src/agent/convergence/ProgressLease.js";

const none: ProgressBoundaryOutcome = { requested: false, attempted: false, applied: false };

test("progress lease stays inert unless explicitly enabled", () => {
  const lease = new ProgressLease();
  assert.equal(lease.observe(report(), none), undefined);
  assert.equal(lease.shouldForceBoundary(), false);
});

test("opaque hash churn is stagnant while a smaller remaining count renews the lease", () => {
  const lease = configuredLease();
  assert.equal(lease.observe(report(), none)?.decision, "baseline");
  assert.equal(lease.observe(report({ stateHash: "state-b" }), none)?.decision, "stagnant");
  assert.equal(lease.observe(report({ stateHash: "state-b", remainingCount: 3 }), none)?.decision, "renewed");
  assert.equal(lease.shouldForceBoundary(), false);
});

test("only a strictly increasing domain progress ordinal renews the lease", () => {
  const lease = configuredLease();
  assert.equal(lease.observe(report({ progressOrdinal: 7 }), none)?.decision, "baseline");
  assert.equal(lease.observe(report({ stateHash: "state-b", progressOrdinal: 8 }), none)?.decision, "renewed");
  assert.equal(lease.observe(report({ stateHash: "state-c", progressOrdinal: 8 }), none)?.decision, "stagnant");
  const replayed = lease.observe(report({ stateHash: "state-d", progressOrdinal: 7 }), none);
  assert.equal(replayed?.decision, "stagnant");
  assert.equal(replayed?.forceBoundaryNext, true);
});

test("a lower remaining count cannot roll the stored progress ordinal backward", () => {
  const lease = configuredLease();
  lease.observe(report({ remainingCount: 5, progressOrdinal: 8 }), none);
  assert.equal(lease.observe(report({ remainingCount: 4, progressOrdinal: 7 }), none)?.decision, "renewed");
  assert.equal(lease.observe(report({ remainingCount: 4, progressOrdinal: 8 }), none)?.decision, "stagnant");
});

test("two stagnant observations require a boundary and allow exactly one post-boundary turn", () => {
  const lease = configuredLease();
  lease.observe(report(), none);

  const firstStagnation = lease.observe(report(), none);
  assert.equal(firstStagnation?.decision, "stagnant");
  assert.equal(firstStagnation?.forceBoundaryNext, true);
  assert.equal(lease.shouldForceBoundary(), true);

  const boundaryGrace = lease.observe(report(), { requested: true, attempted: true, applied: true });
  assert.equal(boundaryGrace?.decision, "boundary_grace");
  assert.equal(lease.shouldForceBoundary(), false);

  const failed = lease.observe(report(), none);
  assert.equal(failed?.decision, "fail_closed");
  assert.equal(failed?.reason, "post_boundary_stagnation");
});

test("cold-start allowance expires after the first explicit domain progress", () => {
  const lease = new ProgressLease({
    enabled: true,
    mode: "evaluation",
    maxStagnantObservations: 2,
    maxInitialStagnantObservations: 4,
  });
  lease.observe(report(), none);

  assert.equal(lease.observe(report(), none)?.forceBoundaryNext, false);
  assert.equal(lease.observe(report(), none)?.forceBoundaryNext, false);
  assert.equal(lease.observe(report(), none)?.forceBoundaryNext, true);

  const renewed = lease.observe(report({ stateHash: "initialized", progressOrdinal: 1 }), none);
  assert.equal(renewed?.decision, "renewed");
  assert.equal(lease.shouldForceBoundary(), false);

  const steadyStateStagnation = lease.observe(report({ stateHash: "initialized", progressOrdinal: 1 }), none);
  assert.equal(steadyStateStagnation?.forceBoundaryNext, true);
});

test("evaluation mode fails closed when the required boundary is rejected or unavailable", () => {
  for (const boundary of [
    { requested: true, attempted: true, applied: false, rejectionReason: "post_compact_blocking" },
    { requested: true, attempted: false, applied: false },
  ] satisfies ProgressBoundaryOutcome[]) {
    const lease = configuredLease();
    lease.observe(report(), none);
    lease.observe(report(), none);
    const result = lease.observe(report(), boundary);
    assert.equal(result?.decision, "fail_closed");
  }
});

test("a completed report releases the tracked scope", () => {
  const lease = configuredLease();
  lease.observe(report(), none);
  lease.observe(report(), none);
  const completed = lease.observe(report({ remainingCount: 0, blockingCode: undefined }), none);
  assert.equal(completed?.decision, "completed");
  assert.equal(lease.shouldForceBoundary(), false);
});

test("convergence metadata parser rejects malformed and oversized reports", () => {
  assert.equal(parseConvergenceReport(undefined), undefined);
  assert.equal(parseConvergenceReport({ ...report(), remainingCount: -1 }), undefined);
  assert.equal(parseConvergenceReport({ ...report(), progressOrdinal: -1 }), undefined);
  assert.equal(parseConvergenceReport({ ...report(), progressOrdinal: 1.5 }), undefined);
  assert.equal(parseConvergenceReport({ ...report(), scope: "x".repeat(129) }), undefined);
  assert.deepEqual(parseConvergenceReport(report()), report());
});

function configuredLease(): ProgressLease {
  return new ProgressLease({ enabled: true, mode: "evaluation", maxStagnantObservations: 2 });
}

function report(overrides: Partial<ConvergenceReport> = {}): ConvergenceReport {
  return {
    schemaVersion: 1,
    scope: "domain-validation",
    phase: "coverage",
    stateHash: "state-a",
    blockingCode: "coverage_missing",
    remainingCount: 4,
    ...overrides,
  };
}
