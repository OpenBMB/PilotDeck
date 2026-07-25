import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type { TokenBudgetSnapshot } from "../../src/context/budget/TokenBudgetManager.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { ProgressLease } from "../../src/agent/convergence/ProgressLease.js";

const messages: CanonicalMessage[] = [{
  role: "user",
  content: [{ type: "text", text: "synthetic context fixture" }],
}];

test("auto compaction reports summary success separately from rejected oversized output", async () => {
  const runtime = createRuntime();
  let evaluations = 0;

  const result = await runtime.tryAutoCompact({
    messages,
    budgetEvaluator: async () => evaluations++ === 0
      ? snapshot("blocking", 95_500, 0.955)
      : snapshot("blocking", 102_000, 1.02),
  });

  assert.equal(result.type, "skipped");
  assert.deepEqual(result.trace?.attemptedTiers, ["full"]);
  assert.equal(result.trace?.summarySucceeded, true);
  assert.equal(result.trace?.appliedTier, undefined);
  assert.equal(result.trace?.rejectionReason, "post_compact_blocking");
  assert.equal(result.trace?.initialSnapshot.state, "blocking");
  assert.equal(result.trace?.finalSnapshot.state, "blocking");
});

test("auto compaction marks a budget-clearing summary as applied", async () => {
  const runtime = createRuntime();
  let evaluations = 0;

  const result = await runtime.tryAutoCompact({
    messages,
    budgetEvaluator: async () => evaluations++ === 0
      ? snapshot("blocking", 95_500, 0.955)
      : snapshot("ok", 40_000, 0.4),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.trace?.appliedTier, "full");
  assert.equal(result.trace?.summarySucceeded, true);
  assert.equal(result.trace?.rejectionReason, undefined);
  assert.equal(result.trace?.finalSnapshot.state, "ok");
});

test("progress policy can force a full boundary while the token budget is still healthy", async () => {
  const runtime = createRuntime();
  const result = await runtime.tryAutoCompact({
    messages,
    forceFull: true,
    budgetEvaluator: async () => snapshot("ok", 40_000, 0.4),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.trace?.triggered, true);
  assert.deepEqual(result.trace?.attemptedTiers, ["full"]);
  assert.equal(result.trace?.appliedTier, "full");
});

test("sanitized Case 09 replay retains enough evidence to detect rejected blocking compactions", async () => {
  const fixture = JSON.parse(await readFile(
    resolve("tests/fixtures/convergence/case-09-context-replay.json"),
    "utf8",
  )) as {
    sanitization: Record<string, boolean>;
    transitions: Array<{
      state: string;
      compaction?: { attempted: boolean; summarySucceeded: boolean; applied: boolean };
    }>;
    expectedPolicy: { evaluation: { maxConsecutiveRejectedBlockingCompactions: number; decision: string } };
  };

  assert.equal(Object.values(fixture.sanitization).some(Boolean), false);
  const rejectedBlocking = fixture.transitions.filter((entry) =>
    entry.state === "blocking"
      && entry.compaction?.attempted === true
      && entry.compaction.summarySucceeded === true
      && entry.compaction.applied === false
  );
  assert.ok(rejectedBlocking.length > fixture.expectedPolicy.evaluation.maxConsecutiveRejectedBlockingCompactions);
  assert.equal(fixture.expectedPolicy.evaluation.decision, "fail_closed");

  const lease = new ProgressLease({
    enabled: true,
    mode: "evaluation",
    maxStagnantObservations: fixture.expectedPolicy.evaluation.maxConsecutiveRejectedBlockingCompactions,
  });
  const report = {
    schemaVersion: 1 as const,
    scope: "sanitized-case-09",
    phase: "coverage",
    stateHash: "opaque-replay-state",
    blockingCode: "opaque-blocker",
    remainingCount: 13,
  };
  let decision: string | undefined;
  for (const transition of rejectedBlocking.slice(0, 3)) {
    const boundaryRequested = lease.shouldForceBoundary();
    decision = lease.observe(report, {
      requested: boundaryRequested,
      attempted: transition.compaction?.attempted === true,
      applied: transition.compaction?.applied === true,
      rejectionReason: transition.compaction?.applied === false ? "post_compact_blocking" : undefined,
    })?.decision;
  }
  assert.equal(decision, "fail_closed");
});

function createRuntime(): DefaultContextRuntime {
  return new DefaultContextRuntime({
    tokenBudget: {} as never,
    autoCompactionPolicy: {
      evaluateSnapshot(current: TokenBudgetSnapshot) {
        return { type: "trigger" as const, reason: "blocking_threshold" as const, snapshot: current };
      },
    } as never,
    compactionEngine: {
      async run() {
        return {
          trigger: "auto" as const,
          preTokens: 95_500,
          summaryMessage: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "synthetic compact summary" }],
          },
          boundaryMarker: {
            role: "user" as const,
            content: [{ type: "text" as const, text: "<compact-boundary />" }],
          },
          messagesToKeep: [],
          attachments: [],
          hookResults: [],
          diagnostics: [],
        };
      },
    } as never,
  });
}

function snapshot(state: TokenBudgetSnapshot["state"], tokens: number, ratio: number): TokenBudgetSnapshot {
  return {
    tokens,
    maxContextTokens: 100_000,
    warningRatio: 0.8,
    blockingRatio: 0.95,
    state,
    ratio,
  };
}
