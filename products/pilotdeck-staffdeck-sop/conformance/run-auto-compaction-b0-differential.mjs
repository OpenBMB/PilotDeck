#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const b0Policy = await import(pathToFileURL(join(b0Root, "dist/src/context/compaction/AutoCompactionPolicy.js")).href);
const candidatePolicy = await import(pathToFileURL(join(candidateRoot, "dist/src/context/compaction/AutoCompactionPolicy.js")).href);
const b0Budget = await import(pathToFileURL(join(b0Root, "dist/src/context/budget/TokenBudgetManager.js")).href);
const candidateBudget = await import(pathToFileURL(join(candidateRoot, "dist/src/context/budget/TokenBudgetManager.js")).href);

const cases = [
  { name: "before-warning-threshold", tokens: 79 },
  { name: "at-warning-threshold", tokens: 80 },
  { name: "before-blocking-threshold", tokens: 89 },
  { name: "at-blocking-threshold", tokens: 90 },
  { name: "reserved-output-shifts-boundary", tokens: 80, reservedOutputTokens: 10 },
];

const normalized = [];
for (const testCase of cases) {
  const expected = runCase(testCase, b0Policy.AutoCompactionPolicy, b0Budget.TokenBudgetManager);
  const actual = runCase(testCase, candidatePolicy.AutoCompactionPolicy, candidateBudget.TokenBudgetManager);
  assert.deepEqual(actual, expected, `Automatic compaction differential mismatch in ${testCase.name}`);
  normalized.push({ name: testCase.name, result: actual });
}

const altered = structuredClone(normalized[3].result);
altered.decision.reason = "warning_threshold";
assert.notDeepEqual(
  altered,
  normalized[3].result,
  "comparator sensitivity fixture did not detect a changed compaction trigger reason",
);

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: normalized.map(({ name }) => name),
  compared: normalized.length,
}, null, 2) + "\n");

function runCase(testCase, AutoCompactionPolicy, TokenBudgetManager) {
  const budget = new TokenBudgetManager();
  const policy = new AutoCompactionPolicy({ tokenBudget: budget });
  const snapshot = budget.snapshotFromTokens(testCase.tokens, 100, {
    reservedOutputTokens: testCase.reservedOutputTokens,
  });
  return {
    snapshot,
    decision: policy.evaluateSnapshot(snapshot),
    evaluated: policy.evaluate(
      [{ role: "user", content: [{ type: "text", text: "threshold fixture" }] }],
      100,
      { reservedOutputTokens: testCase.reservedOutputTokens },
    ),
  };
}
