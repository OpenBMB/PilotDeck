import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

import {
  ARMS,
  OUTPUT_DIRECTORY,
  renderReport,
  renderSummaryCsv,
  runOfflineExperiment,
  serializeOfflineExperiment,
  type TurnRecord,
} from "../../../scripts/experiments/cacheAwareRoutingOffline.js";

function turn(
  records: TurnRecord[],
  scenario: string,
  arm: typeof ARMS[number],
  turnNumber: number,
): TurnRecord {
  const found = records.find((record) =>
    record.scenario === scenario && record.arm === arm && record.turn === turnNumber
  );
  assert.ok(found, `missing ${scenario}/${arm}/turn-${turnNumber}`);
  return found;
}

test("experiment emits exactly seven scenarios by three arms", () => {
  const result = runOfflineExperiment();
  assert.equal(result.scenarioSummaries.length, 7 * 3);
  assert.equal(result.overallSummaries.length, 3);
  assert.deepEqual([...new Set(result.scenarioSummaries.map((summary) => summary.scenario))].sort(), [
    "cold_start",
    "hot_strong_then_simple",
    "lower_output_cost",
    "prefix_changed_compaction",
    "same_model_stable_prefix",
    "ttl_expired",
    "unsupported_candidate",
  ]);
  for (const scenario of new Set(result.scenarioSummaries.map((summary) => summary.scenario))) {
    assert.deepEqual(
      result.scenarioSummaries.filter((summary) => summary.scenario === scenario).map((summary) => summary.arm),
      ARMS,
    );
  }
  assert.equal(result.metadata.networkRequests, 0);
  assert.equal(result.metadata.paidApiCalls, 0);
});

test("all simulated and estimated input buckets are mutually exclusive", () => {
  const result = runOfflineExperiment();
  for (const record of result.turnRecords) {
    const usage = record.canonicalUsage;
    assert.equal(
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      fixtureTotalInput(result, record),
      `${record.scenario}/${record.arm}/${record.turn}: simulated buckets`,
    );
    assert.ok(usage.inputTokens >= 0);
    assert.ok(usage.cacheReadTokens >= 0);
    assert.ok(usage.cacheWriteTokens >= 0);
    if (record.costComparison) {
      for (const side of [record.costComparison.stay, record.costComparison.switch]) {
        assert.equal(
          side.buckets.inputTokens + side.buckets.cacheReadTokens + side.buckets.cacheWriteTokens,
          record.costComparison.estimatedInputTokens,
          `${record.scenario}/${record.arm}/${record.turn}: estimate buckets`,
        );
      }
    }
  }
});

test("same-model baseline has real Anthropic wire markers in every arm", () => {
  const records = runOfflineExperiment().turnRecords;
  for (const arm of ARMS) {
    const baseline = turn(records, "same_model_stable_prefix", arm, 1);
    assert.equal(baseline.cachePlanMatchesFinal, true);
    assert.equal(baseline.wire.systemMarker, true);
    assert.equal(baseline.wire.messageMarkerCount, 3);
    assert.equal(baseline.cacheRequestCorrect, true);
  }
});

test("hot strong-to-simple exposes baseline marker loss and fixed hot Haiku read", () => {
  const records = runOfflineExperiment().turnRecords;
  for (const turnNumber of [3, 4]) {
    const original = turn(records, "hot_strong_then_simple", "original", turnNumber);
    assert.equal(original.finalModel, "anthropic/claude-haiku-sim");
    assert.equal(original.cachePlan.present, false);
    assert.equal(original.wire.markerCount, 0);
    assert.equal(original.canonicalUsage.inputTokens, fixtureTotalInputFromRecord(original));
    assert.equal(original.canonicalUsage.cacheReadTokens, 0);
    assert.equal(original.canonicalUsage.cacheWriteTokens, 0);
  }
  for (const arm of ["plan_fix_only", "plan_and_full_cost"] as const) {
    const coldHaiku = turn(records, "hot_strong_then_simple", arm, 3);
    const hotHaiku = turn(records, "hot_strong_then_simple", arm, 4);
    assert.equal(coldHaiku.cacheRequestCorrect, true);
    assert.ok(coldHaiku.canonicalUsage.cacheWriteTokens > 0);
    assert.equal(hotHaiku.cacheRequestCorrect, true);
    assert.ok(hotHaiku.canonicalUsage.cacheReadTokens > 0);
  }
});

test("compaction changes the real plan fingerprint and simulates a miss/write", () => {
  const records = runOfflineExperiment().turnRecords;
  for (const arm of ARMS) {
    const before = turn(records, "prefix_changed_compaction", arm, 2);
    const after = turn(records, "prefix_changed_compaction", arm, 3);
    assert.notEqual(after.cachePlan.fingerprint, before.cachePlan.fingerprint);
    assert.equal(after.cachePlan.generation, 2);
    assert.equal(after.canonicalUsage.cacheReadTokens, 0);
    assert.ok(after.canonicalUsage.cacheWriteTokens > 0);
  }
});

test("TTL expiry since the last hit simulates a final miss/write", () => {
  const records = runOfflineExperiment().turnRecords;
  for (const arm of ARMS) {
    const expired = turn(records, "ttl_expired", arm, 3);
    assert.equal(expired.canonicalUsage.cacheReadTokens, 0);
    assert.ok(expired.canonicalUsage.cacheWriteTokens > 0);
  }
});

test("full-cost unsupported edge decision has no plan, markers, or cache buckets", () => {
  const records = runOfflineExperiment().turnRecords;
  const edge = turn(records, "unsupported_candidate", "plan_and_full_cost", 3);
  assert.equal(edge.judgeTarget, "local/edge-small-sim");
  assert.equal(edge.finalModel, "local/edge-small-sim");
  assert.equal(edge.decisionReason, "full_cost_recommends_switch");
  assert.equal(edge.costComparison?.recommendation, "switch");
  assert.equal(edge.cachePlan.present, false);
  assert.equal(edge.wire.markerCount, 0);
  assert.equal(edge.cacheRequestCorrect, true);
  assert.equal(edge.canonicalUsage.cacheReadTokens, 0);
  assert.equal(edge.canonicalUsage.cacheWriteTokens, 0);
  assert.equal(edge.rawUsage.prompt_tokens_details instanceof Object, true);
});

test("lower-output and unsupported full-cost decisions are pinned to computed outcomes", () => {
  const records = runOfflineExperiment().turnRecords;
  const outputFull = turn(records, "lower_output_cost", "plan_and_full_cost", 3);
  assert.equal(outputFull.finalModel, "anthropic/claude-haiku-sim");
  assert.equal(outputFull.costComparison?.recommendation, "switch");
  assert.ok((outputFull.costComparison?.savingsUsd ?? 0) > 0);

  for (const arm of ["original", "plan_fix_only"] as const) {
    const legacyOutput = turn(records, "lower_output_cost", arm, 3);
    assert.equal(legacyOutput.finalModel, "anthropic/claude-sonnet-sim");
    assert.equal(legacyOutput.costComparison?.recommendation, "keep");
    const legacyUnsupported = turn(records, "unsupported_candidate", arm, 3);
    assert.equal(legacyUnsupported.finalModel, "anthropic/claude-sonnet-sim");
    assert.equal(legacyUnsupported.costComparison?.recommendation, "keep");
  }

  const unsupportedFull = turn(records, "unsupported_candidate", "plan_and_full_cost", 3);
  assert.equal(unsupportedFull.finalModel, "local/edge-small-sim");
  assert.equal(unsupportedFull.costComparison?.recommendation, "switch");
});

test("serialization and checked-in output snapshots are deterministic", async () => {
  const first = runOfflineExperiment();
  const second = runOfflineExperiment();
  assert.equal(serializeOfflineExperiment(first), serializeOfflineExperiment(second));
  assert.equal(renderSummaryCsv(first), renderSummaryCsv(second));
  assert.equal(renderReport(first), renderReport(second));

  const outputDirectory = resolve(OUTPUT_DIRECTORY);
  const [raw, csv, report] = await Promise.all([
    readFile(resolve(outputDirectory, "raw-results.json"), "utf8"),
    readFile(resolve(outputDirectory, "summary.csv"), "utf8"),
    readFile(resolve(outputDirectory, "report.md"), "utf8"),
  ]);
  assert.equal(raw, serializeOfflineExperiment(first));
  assert.equal(csv, renderSummaryCsv(first));
  assert.equal(report, renderReport(first));
});

test("report discloses metric denominators and the emulated baseline boundary", () => {
  const report = renderReport(runOfflineExperiment());
  assert.match(report, /计划匹配率仅以最终模型支持 prompt cache 的请求为分母/);
  assert.match(report, /缓存资格请求/);
  assert.match(report, /并未执行独立的 `cfc4d177` checkout 或 binary/);
});

function fixtureTotalInput(result: ReturnType<typeof runOfflineExperiment>, record: TurnRecord): number {
  const scenarios = result.fixtures.scenarios as Array<{
    id: string;
    turns: Array<{ totalInputTokens: number }>;
  }>;
  const scenario = scenarios.find((candidate) => candidate.id === record.scenario);
  assert.ok(scenario);
  return scenario.turns[record.turn - 1]!.totalInputTokens;
}

function fixtureTotalInputFromRecord(record: TurnRecord): number {
  if (record.scenario !== "hot_strong_then_simple") throw new Error("unexpected scenario");
  return record.turn === 3 ? 195_000 : 200_000;
}
