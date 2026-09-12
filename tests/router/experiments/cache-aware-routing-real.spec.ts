import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildRealExperimentPayload,
  REAL_EXPERIMENT_OUTPUT_DIRECTORY,
  REAL_EXPERIMENT_MAX_OUTPUT_TOKENS,
  REAL_EXPERIMENT_MAX_REQUESTS,
  REAL_EXPERIMENT_PREFIX_WORDS,
  renderRealExperimentReport,
  type RealExperimentResult,
} from "../../../scripts/experiments/cacheAwareRoutingReal.js";

test("real experiment stays within the approved request and token bounds", () => {
  assert.equal(REAL_EXPERIMENT_MAX_REQUESTS, 12);
  assert.ok(REAL_EXPERIMENT_MAX_OUTPUT_TOKENS <= 256);
  assert.ok(REAL_EXPERIMENT_PREFIX_WORDS <= 8_000);
});

test("real experiment compares frozen marker loss with production plan rebuild", () => {
  const original = buildRealExperimentPayload({
    arm: "original",
    model: "qwen3.5-mini",
    lineage: "test-original",
  });
  const fixed = buildRealExperimentPayload({
    arm: "plan_fix_only",
    model: "qwen3.5-mini",
    lineage: "test-fixed",
  });

  assert.equal(original.markerCount, 0);
  assert.equal(fixed.markerCount, 4);
  assert.equal(original.body.max_tokens, REAL_EXPERIMENT_MAX_OUTPUT_TOKENS);
  assert.equal(fixed.body.max_tokens, REAL_EXPERIMENT_MAX_OUTPUT_TOKENS);
  assert.equal(fixed.body.model, "qwen3.5-mini");
});

test("checked-in real report preserves unknown cache usage as n/a", async () => {
  const outputDirectory = resolve(REAL_EXPERIMENT_OUTPUT_DIRECTORY);
  const [raw, report] = await Promise.all([
    readFile(resolve(outputDirectory, "raw-results.json"), "utf8"),
    readFile(resolve(outputDirectory, "report.md"), "utf8"),
  ]);
  const result = JSON.parse(raw) as RealExperimentResult;

  assert.equal(report, renderRealExperimentReport(result));
  assert.match(report, /缓存效果未验证/);
  assert.match(report, /\| plan_fix_only \| smoke \| 2 \| n\/a \| n\/a \|/);
});
