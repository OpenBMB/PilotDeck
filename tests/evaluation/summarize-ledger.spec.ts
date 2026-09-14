import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("ledger summary keeps cost and usage provenance visible", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotroute-summary-"));
  const input = path.join(dir, "calls.jsonl");
  const output = path.join(dir, "summary");
  const base = {
    taskId: "task-1", role: "main", startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
  };
  fs.writeFileSync(input, [
    { ...base, cost: 1, costSource: "provider_reported", usageSource: "provider_reported" },
    { ...base, cost: 2, costSource: "price_table_calculated", usageSource: "provider_reported" },
    { ...base, cost: 3, costSource: "estimated", usageSource: "estimated" },
    { ...base, costSource: "unknown", usageSource: "unknown" },
  ].map((row) => JSON.stringify(row)).join("\n"));

  const run = spawnSync(process.execPath, [
    "--import", "tsx", "scripts/evaluation/summarize-ledger.mts", input, output,
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);

  const summary = JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
  assert.equal(summary.knownCostUsd, 6);
  assert.deepEqual(summary.costBySource, {
    provider_reported: { attempts: 1, costUsd: 1 },
    price_table_calculated: { attempts: 1, costUsd: 2 },
    estimated: { attempts: 1, costUsd: 3 },
    unknown: { attempts: 1, costUsd: 0 },
  });
  assert.deepEqual(summary.usageBySource, {
    provider_reported: { attempts: 2 }, estimated: { attempts: 1 }, unknown: { attempts: 1 },
  });
  assert.equal(summary.reconciliationEligible, false);
  const csv = fs.readFileSync(path.join(output, "tasks.csv"), "utf8");
  assert.match(csv, /provider_reported_cost_usd,price_table_cost_usd,estimated_cost_usd/);
  fs.rmSync(dir, { recursive: true, force: true });
});
