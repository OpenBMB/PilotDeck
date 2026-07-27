import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProgressLease,
  parseConvergenceReport,
  type ConvergenceReport,
  type ProgressBoundaryOutcome,
} from "../../src/agent/convergence/ProgressLease.js";
import { PhaseBudgetController } from "../../src/agent/convergence/PhaseBudget.js";

const none: ProgressBoundaryOutcome = { requested: false, attempted: false, applied: false };

test("phase budget preserves a finalization reserve without changing lease policy", () => {
  const controller = new PhaseBudgetController({
    enabled: true,
    finalizationReserveMs: 300_000,
    phaseBudgetsMs: { matrices: 900_000 },
  }, 2_100_000, 0);
  assert.deepEqual(controller.evaluate("matrices", 800_000), {
    phase: "matrices",
    allowed: true,
    finishFirst: false,
    remainingMs: 1_300_000,
    reserveMs: 300_000,
    phaseBudgetMs: 900_000,
    reason: "within_budget",
  });
  assert.equal(controller.evaluate("matrices", 1_850_000)?.reason, "finalization_reserve");
  assert.equal(controller.evaluate("matrices", 950_000)?.reason, "phase_budget_exhausted");
  assert.equal(controller.evaluate("coverage", 1_850_000)?.allowed, false);
  assert.equal(controller.evaluate("complete", 2_100_000)?.allowed, false);
});

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

test("a post-tool progress or bounded handoff preview defers but does not consume a required boundary", () => {
  const progressLease = configuredLease();
  progressLease.observe(report({ progressOrdinal: 8, handoffOrdinal: 0 }), none);
  progressLease.observe(report({ progressOrdinal: 8, handoffOrdinal: 0 }), none);

  assert.deepEqual(progressLease.planBoundary([
    report({ progressOrdinal: 9, handoffOrdinal: 0, remainingCount: 3 }),
  ]), {
    requested: false,
    deferredScopes: ["domain-validation"],
    previewEvaluations: [{
      scope: "domain-validation",
      decision: "deferred",
      reason: "preview_progressed",
    }],
  });
  assert.deepEqual(progressLease.planBoundary([
    report({ progressOrdinal: 8, handoffOrdinal: 1 }),
  ]), {
    requested: false,
    deferredScopes: ["domain-validation"],
    previewEvaluations: [{
      scope: "domain-validation",
      decision: "deferred",
      reason: "preview_handoff",
    }],
  });
  assert.equal(
    progressLease.observe(report({ progressOrdinal: 8, handoffOrdinal: 1 }), none)?.decision,
    "handoff_grace",
  );
});

test("replayed, repair-only, and over-budget previews cannot defer a required boundary", () => {
  const replayLease = configuredLease();
  replayLease.observe(report({ progressOrdinal: 8, repairOrdinal: 0, handoffOrdinal: 1 }), none);
  replayLease.observe(report({ progressOrdinal: 8, repairOrdinal: 0, handoffOrdinal: 1 }), none);
  assert.deepEqual(replayLease.planBoundary([
    report({ progressOrdinal: 8, repairOrdinal: 0, handoffOrdinal: 1 }),
  ]), {
    requested: true,
    deferredScopes: [],
    previewEvaluations: [{
      scope: "domain-validation",
      decision: "required",
      reason: "preview_not_renewable",
    }],
  });
  assert.deepEqual(replayLease.planBoundary([
    report({ progressOrdinal: 8, repairOrdinal: 1, handoffOrdinal: 1 }),
  ]), {
    requested: true,
    deferredScopes: [],
    previewEvaluations: [{
      scope: "domain-validation",
      decision: "required",
      reason: "preview_not_renewable",
    }],
  });

  const budgetLease = configuredLease();
  budgetLease.observe(report({ progressOrdinal: 8, handoffOrdinal: 0 }), none);
  budgetLease.observe(report({ progressOrdinal: 8, handoffOrdinal: 1 }), none);
  budgetLease.observe(report({ progressOrdinal: 8, handoffOrdinal: 2 }), none);
  assert.deepEqual(budgetLease.planBoundary([
    report({ progressOrdinal: 8, handoffOrdinal: 3 }),
  ]), {
    requested: true,
    deferredScopes: [],
    previewEvaluations: [{
      scope: "domain-validation",
      decision: "required",
      reason: "preview_not_renewable",
    }],
  });
});

test("previews cannot defer when more than one scope requires a boundary", () => {
  const lease = configuredLease();
  for (const scope of ["domain-a", "domain-b"]) {
    lease.observe(report({ scope, progressOrdinal: 1 }), none);
    lease.observe(report({ scope, progressOrdinal: 1 }), none);
  }

  assert.deepEqual(lease.planBoundary([
    report({ scope: "domain-a", progressOrdinal: 2 }),
    report({ scope: "domain-b", progressOrdinal: 2 }),
  ]), {
    requested: true,
    deferredScopes: [],
    previewEvaluations: [
      { scope: "domain-a", decision: "required", reason: "multiple_scopes" },
      { scope: "domain-b", decision: "required", reason: "multiple_scopes" },
    ],
  });
});

test("a missing preview is observable without changing the required boundary", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 8 }), none);
  lease.observe(report({ progressOrdinal: 8 }), none);

  assert.deepEqual(lease.planBoundary(), {
    requested: true,
    deferredScopes: [],
    previewEvaluations: [{
      scope: "domain-validation",
      decision: "required",
      reason: "preview_missing",
    }],
  });
});

test("new repair feedback after a boundary gets one delivery turn without renewing progress", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0 }), none);
  assert.equal(
    lease.observe(
      report({ progressOrdinal: 1, repairOrdinal: 0 }),
      { requested: true, attempted: true, applied: true },
    )?.decision,
    "boundary_grace",
  );

  const feedback = lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1 }), none);
  assert.equal(feedback?.decision, "feedback_grace");
  assert.equal(feedback?.stagnantObservations, 3);
  assert.equal(lease.shouldForceBoundary(), false);

  const replayed = lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1 }), none);
  assert.equal(replayed?.decision, "fail_closed");
  assert.equal(replayed?.reason, "post_boundary_stagnation");
});

test("genuine progress after repair feedback renews the lease", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0 }), none);
  lease.observe(
    report({ progressOrdinal: 1, repairOrdinal: 0 }),
    { requested: true, attempted: true, applied: true },
  );
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1 }), none);

  const renewed = lease.observe(report({ progressOrdinal: 2, repairOrdinal: 1 }), none);
  assert.equal(renewed?.decision, "renewed");
  assert.equal(renewed?.stagnantObservations, 0);
});

test("a newly prepared repair target gets one non-progress request after feedback", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0, repairPreparationOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0, repairPreparationOrdinal: 0 }), none);
  lease.observe(
    report({ progressOrdinal: 1, repairOrdinal: 0, repairPreparationOrdinal: 0 }),
    { requested: true, attempted: true, applied: true },
  );
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1, repairPreparationOrdinal: 0 }), none);

  const preparation = lease.observe(
    report({ progressOrdinal: 1, repairOrdinal: 1, repairPreparationOrdinal: 1 }),
    none,
  );
  assert.equal(preparation?.decision, "repair_preparation_grace");
  assert.equal(preparation?.stagnantObservations, 4);

  const replayed = lease.observe(
    report({ progressOrdinal: 1, repairOrdinal: 1, repairPreparationOrdinal: 1 }),
    none,
  );
  assert.equal(replayed?.decision, "fail_closed");
  assert.equal(replayed?.reason, "post_boundary_stagnation");
});

test("genuine progress immediately after repair preparation renews the lease", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0, repairPreparationOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0, repairPreparationOrdinal: 0 }), none);
  lease.observe(
    report({ progressOrdinal: 1, repairOrdinal: 0, repairPreparationOrdinal: 0 }),
    { requested: true, attempted: true, applied: true },
  );
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1, repairPreparationOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1, repairPreparationOrdinal: 1 }), none);

  const renewed = lease.observe(
    report({ progressOrdinal: 2, repairOrdinal: 1, repairPreparationOrdinal: 1 }),
    none,
  );
  assert.equal(renewed?.decision, "renewed");
  assert.equal(renewed?.stagnantObservations, 0);
});

test("repair feedback co-delivered by a boundary preserves the later preparation turn", () => {
  const lease = configuredLease();
  lease.observe(
    report({ progressOrdinal: 5, repairOrdinal: 1, repairPreparationOrdinal: 1 }),
    none,
  );

  const stagnant = lease.observe(
    report({ progressOrdinal: 5, repairOrdinal: 1, repairPreparationOrdinal: 1 }),
    none,
  );
  assert.equal(stagnant?.decision, "stagnant");
  assert.equal(stagnant?.forceBoundaryNext, true);

  const boundary = lease.observe(
    report({ progressOrdinal: 5, repairOrdinal: 2, repairPreparationOrdinal: 1 }),
    { requested: true, attempted: true, applied: true },
  );
  assert.equal(boundary?.decision, "boundary_grace");

  const preparation = lease.observe(
    report({ progressOrdinal: 5, repairOrdinal: 2, repairPreparationOrdinal: 2 }),
    none,
  );
  assert.equal(preparation?.decision, "repair_preparation_grace");

  const renewed = lease.observe(
    report({ progressOrdinal: 6, repairOrdinal: 2, repairPreparationOrdinal: 2 }),
    none,
  );
  assert.equal(renewed?.decision, "renewed");
});

test("a boundary co-delivering repair feedback and preparation grants no replay turn", () => {
  const lease = configuredLease();
  lease.observe(
    report({ progressOrdinal: 5, repairOrdinal: 1, repairPreparationOrdinal: 1 }),
    none,
  );
  lease.observe(
    report({ progressOrdinal: 5, repairOrdinal: 1, repairPreparationOrdinal: 1 }),
    none,
  );

  const boundary = lease.observe(
    report({ progressOrdinal: 5, repairOrdinal: 2, repairPreparationOrdinal: 2 }),
    { requested: true, attempted: true, applied: true },
  );
  assert.equal(boundary?.decision, "boundary_grace");

  const replayed = lease.observe(
    report({ progressOrdinal: 5, repairOrdinal: 2, repairPreparationOrdinal: 2 }),
    none,
  );
  assert.equal(replayed?.decision, "fail_closed");
  assert.equal(replayed?.reason, "post_boundary_stagnation");
});

test("preparation observed before feedback cannot be replayed after the boundary", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0, repairPreparationOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0, repairPreparationOrdinal: 1 }), none);
  lease.observe(
    report({ progressOrdinal: 1, repairOrdinal: 0, repairPreparationOrdinal: 1 }),
    { requested: true, attempted: true, applied: true },
  );
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1, repairPreparationOrdinal: 1 }), none);

  const replayed = lease.observe(
    report({ progressOrdinal: 1, repairOrdinal: 1, repairPreparationOrdinal: 1 }),
    none,
  );
  assert.equal(replayed?.decision, "fail_closed");
});

test("a second repair revision cannot replace missing progress after feedback", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0 }), none);
  lease.observe(
    report({ progressOrdinal: 1, repairOrdinal: 0 }),
    { requested: true, attempted: true, applied: true },
  );
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1 }), none);

  const secondRepair = lease.observe(report({ progressOrdinal: 1, repairOrdinal: 2 }), none);
  assert.equal(secondRepair?.decision, "fail_closed");
});

test("repair feedback already delivered before a boundary cannot be replayed as grace", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 1, repairOrdinal: 0 }), none);
  assert.equal(
    lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1 }), none)?.decision,
    "stagnant",
  );
  lease.observe(
    report({ progressOrdinal: 1, repairOrdinal: 1 }),
    { requested: true, attempted: true, applied: true },
  );

  assert.equal(
    lease.observe(report({ progressOrdinal: 1, repairOrdinal: 1 }), none)?.decision,
    "fail_closed",
  );
});

test("a new operational handoff gets one bounded request without renewing progress", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 0 }), none);

  const handoff = lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 1 }), none);
  assert.equal(handoff?.decision, "handoff_grace");
  assert.equal(handoff?.stagnantObservations, 1);
  assert.equal(handoff?.forceBoundaryNext, true);

  lease.observe(
    report({ progressOrdinal: 8, handoffOrdinal: 1 }),
    { requested: true, attempted: true, applied: true },
  );
  const replayed = lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 1 }), none);
  assert.equal(replayed?.decision, "fail_closed");
  assert.equal(replayed?.reason, "post_boundary_stagnation");
});

test("a post-boundary handoff is bounded and its replay still fails closed", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 0 }), none);
  lease.observe(
    report({ progressOrdinal: 8, handoffOrdinal: 0 }),
    { requested: true, attempted: true, applied: true },
  );

  assert.equal(
    lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 1 }), none)?.decision,
    "handoff_grace",
  );
  assert.equal(
    lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 1 }), none)?.decision,
    "fail_closed",
  );
});

test("simultaneous repair and handoff revisions cannot be redeemed on separate turns", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 8, repairOrdinal: 0, handoffOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 8, repairOrdinal: 0, handoffOrdinal: 0 }), none);
  lease.observe(
    report({ progressOrdinal: 8, repairOrdinal: 0, handoffOrdinal: 0 }),
    { requested: true, attempted: true, applied: true },
  );

  assert.equal(
    lease.observe(report({ progressOrdinal: 8, repairOrdinal: 1, handoffOrdinal: 1 }), none)?.decision,
    "handoff_grace",
  );
  assert.equal(
    lease.observe(report({ progressOrdinal: 8, repairOrdinal: 1, handoffOrdinal: 1 }), none)?.decision,
    "fail_closed",
  );
});

test("a lower handoff ordinal cannot be replayed as grace", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 2 }), none);
  const rolledBack = lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 1 }), none);
  assert.equal(rolledBack?.decision, "stagnant");
  assert.equal(rolledBack?.forceBoundaryNext, true);
});

test("handoff allowance has a hard per-progress-epoch limit and resets only on progress", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 1, handoffOrdinal: 0 }), none);
  assert.equal(lease.observe(report({ progressOrdinal: 1, handoffOrdinal: 1 }), none)?.decision, "handoff_grace");
  assert.equal(lease.observe(report({ progressOrdinal: 1, handoffOrdinal: 2 }), none)?.decision, "handoff_grace");

  const overLimit = lease.observe(report({ progressOrdinal: 1, handoffOrdinal: 3 }), none);
  assert.equal(overLimit?.decision, "stagnant");
  assert.equal(overLimit?.stagnantObservations, 3);

  assert.equal(
    lease.observe(report({ progressOrdinal: 2, handoffOrdinal: 3 }), none)?.decision,
    "renewed",
  );
  assert.equal(
    lease.observe(report({ progressOrdinal: 2, handoffOrdinal: 4 }), none)?.decision,
    "handoff_grace",
  );
});

test("handoff cannot bypass an unavailable required boundary", () => {
  const lease = configuredLease();
  lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 0 }), none);
  lease.observe(report({ progressOrdinal: 8, handoffOrdinal: 0 }), none);

  const failed = lease.observe(
    report({ progressOrdinal: 8, handoffOrdinal: 1 }),
    { requested: true, attempted: false, applied: false },
  );
  assert.equal(failed?.decision, "fail_closed");
  assert.equal(failed?.reason, "boundary_unavailable");
});

test("sanitized Case 09 matrix handoff trajectory reaches the next semantic checkpoint", () => {
  const fixture = JSON.parse(readFileSync(
    join(process.cwd(), "tests/fixtures/convergence/case-09-matrix-handoff-replay.json"),
    "utf8",
  )) as {
    steps: Array<{
      report: Partial<ConvergenceReport>;
      boundary: ProgressBoundaryOutcome;
      expectedDecision: string;
    }>;
  };
  const lease = new ProgressLease({
    enabled: true,
    mode: "evaluation",
    maxStagnantObservations: 2,
    maxInitialStagnantObservations: 8,
  });

  assert.deepEqual(
    fixture.steps.map((step) => lease.observe(report(step.report), step.boundary)?.decision),
    fixture.steps.map((step) => step.expectedDecision),
  );
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
  assert.equal(parseConvergenceReport({ ...report(), repairOrdinal: -1 }), undefined);
  assert.equal(parseConvergenceReport({ ...report(), repairOrdinal: 1.5 }), undefined);
  assert.equal(parseConvergenceReport({ ...report(), repairPreparationOrdinal: -1 }), undefined);
  assert.equal(parseConvergenceReport({ ...report(), repairPreparationOrdinal: 1.5 }), undefined);
  assert.equal(parseConvergenceReport({ ...report(), handoffOrdinal: -1 }), undefined);
  assert.equal(parseConvergenceReport({ ...report(), handoffOrdinal: 1.5 }), undefined);
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
