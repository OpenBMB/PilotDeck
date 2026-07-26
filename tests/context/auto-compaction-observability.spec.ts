import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { CompactionEngine } from "../../src/context/compaction/CompactionEngine.js";
import { collectToolCallIds, collectToolResultIds } from "../../src/context/compaction/toolPairIntegrity.js";
import type { TokenBudgetSnapshot } from "../../src/context/budget/TokenBudgetManager.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../src/model/index.js";
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

test("full compaction distinguishes a protected prefix with no summarizable messages from model failure", async () => {
  let modelCalls = 0;
  const statuses: string[] = [];
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test",
    maxProtectedPrefixTurns: 8,
    model: {
      async *stream() {
        modelCalls += 1;
      },
    },
    eventEmitter(event) {
      if (event.type === "compact_completed") statuses.push(event.status);
    },
  });

  const result = await engine.run({
    trigger: "auto",
    messages: protectedAgentTurns(4),
    keepTailRatio: 0.25,
  });

  assert.equal(result.outcome, "no_summarizable_messages");
  assert.equal(result.error, undefined);
  assert.equal(result.summaryMessage, undefined);
  assert.equal(modelCalls, 0);
  assert.deepEqual(statuses, ["no_summarizable_messages"]);
});

test("auto compaction propagates no-summarizable as a stable rejection reason without claiming a summary attempt", async () => {
  const runtime = new DefaultContextRuntime({
    tokenBudget: {} as never,
    autoCompactionPolicy: {
      evaluateSnapshot(current: TokenBudgetSnapshot) {
        return { type: "trigger" as const, reason: "blocking_threshold" as const, snapshot: current };
      },
    } as never,
    compactionEngine: {
      async run() {
        return {
          outcome: "no_summarizable_messages" as const,
          trigger: "auto" as const,
          preTokens: 95_500,
          boundaryMarker: { role: "user" as const, content: [{ type: "text" as const, text: "<compact-boundary />" }] },
          messagesToKeep: messages,
          attachments: [],
          hookResults: [],
          diagnostics: [],
        };
      },
    } as never,
  });

  const result = await runtime.tryAutoCompact({
    messages,
    budgetEvaluator: async () => snapshot("blocking", 95_500, 0.955),
  });

  assert.equal(result.type, "skipped");
  assert.equal(result.trace?.rejectionReason, "no_summarizable_messages");
  assert.equal(result.trace?.summaryAttempted, false);
  assert.equal(result.trace?.summarySucceeded, undefined);
});

test("bounded protected-prefix retention summarizes old agent turns and preserves every kept tool pair", async () => {
  const requests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test",
    maxProtectedPrefixTurns: 8,
    model: {
      async *stream(request) {
        requests.push(request);
        yield {
          type: "text_delta" as const,
          text: "## Objective\nO\n## Current State\nS\n## Remaining\nR\n## Files And Artifacts\nF",
        };
      },
    },
  });

  const result = await engine.run({
    trigger: "auto",
    messages: protectedAgentTurns(14),
    keepTailRatio: 0.2,
  });

  assert.equal(result.outcome, "summarized");
  assert.equal(requests.length, 1);
  assert.ok((requests[0]?.messages.length ?? 0) > 1);
  assert.ok(result.messagesToKeep.length < protectedAgentTurns(14).length);
  const summarizedMessages = requests[0]!.messages.slice(0, -1);
  assert.deepEqual(collectToolCallIds(summarizedMessages), collectToolResultIds(summarizedMessages));
  assert.deepEqual(collectToolCallIds(result.messagesToKeep), collectToolResultIds(result.messagesToKeep));
});

test("full compaction aligns a message-count tail boundary to complete tool turns", async () => {
  const requests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test",
    maxProtectedPrefixTurns: 0,
    model: {
      async *stream(request) {
        requests.push(request);
        yield { type: "text_delta" as const, text: "turn-aligned summary" };
      },
    },
  });

  const result = await engine.run({
    trigger: "auto",
    messages: protectedAgentTurns(3),
    keepTailRatio: 0.12,
  });

  const summarizedMessages = requests[0]!.messages.slice(0, -1);
  assert.deepEqual(collectToolCallIds(summarizedMessages), collectToolResultIds(summarizedMessages));
  assert.deepEqual(collectToolCallIds(result.messagesToKeep), collectToolResultIds(result.messagesToKeep));
  assert.equal(collectToolCallIds(result.messagesToKeep).size, 1);
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
          outcome: "summarized" as const,
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

function protectedAgentTurns(count: number): CanonicalMessage[] {
  return Array.from({ length: count }, (_, index): CanonicalMessage[] => {
    const id = `agent-${index}`;
    return [
      { role: "user", content: [{ type: "text", text: `bounded task ${index}` }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "agent", input: { task: `task-${index}` } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: id, content: [{ type: "text", text: `done-${index}` }] }],
      },
    ];
  }).flat();
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
