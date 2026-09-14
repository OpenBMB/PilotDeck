import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("analysis produces paired session CI, UX metrics, and concrete failures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotroute-analysis-"));
  const results = path.join(dir, "results.jsonl"), calls = path.join(dir, "calls.jsonl"), output = path.join(dir, "out");
  fs.writeFileSync(results, [
    { taskId: "a", sessionId: "s1", strategy: "base", repeat: 1, success: true, latencyMs: 100, ttftMs: 20 },
    { taskId: "a", sessionId: "s1", strategy: "route", repeat: 1, success: false, latencyMs: 90, ttftMs: 10, failureReason: "validator" },
    { taskId: "b", sessionId: "s2", strategy: "base", repeat: 1, success: false, latencyMs: 120 },
    { taskId: "b", sessionId: "s2", strategy: "route", repeat: 1, success: true, latencyMs: 80 },
  ].map((row) => JSON.stringify(row)).join("\n"));
  fs.writeFileSync(calls, [
    { taskId: "a", strategyVersion: "base", cost: 1, costSource: "provider_reported", role: "main" },
    { taskId: "a", strategyVersion: "route", cost: 0.5, costSource: "provider_reported", role: "main" },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/evaluation/analyze-results.mts", results, calls, output], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PILOTROUTE_BASELINE: "base" },
  });
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
  assert.equal(summary.comparisons[0].pairedTasks, 2);
  assert.deepEqual(summary.comparisons[0].newlyFailedTaskIds, ["a"]);
  assert.equal(summary.rows.find((x: any) => x.strategy === "route").p50TtftMs, 10);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "failures.json"), "utf8")).length, 2);
  assert.equal(fs.existsSync(path.join(output, "cost-success.svg")), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
