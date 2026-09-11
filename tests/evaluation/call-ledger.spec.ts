import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CallLedger } from "../../src/evaluation/CallLedger.js";

test("ledger keeps physical attempts separate and does not price unknown usage as zero", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotroute-ledger-"));
  const filePath = path.join(dir, "run", "calls.jsonl");
  const ledger = new CallLedger({
    filePath,
    modelPricing: { "p/m": { input: 1, output: 2, cacheRead: 0.1 } },
  });
  const common = {
    runId: "run-1", taskId: "task-1", sessionId: "session-1", callId: "call-1",
    strategyVersion: "pilotroute", baselineCommit: "abc", provider: "p", model: "m",
    startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z",
  } as const;
  const failed = ledger.append({
    ...common, role: "main", attemptNumber: 1, status: "failed", errorType: "timeout",
    usageSource: "unknown",
  });
  const recovered = ledger.append({
    ...common, role: "fallback", attemptNumber: 2, status: "succeeded",
    fallbackFromAttemptId: failed.attemptId,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 },
    usageSource: "provider_reported",
  });
  ledger.dispose();

  assert.equal(failed.cost, undefined);
  assert.equal(failed.costSource, "unknown");
  assert.equal(recovered.cost, 0.000155);
  assert.equal(recovered.costSource, "price_table_calculated");
  const rows = fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].fallbackFromAttemptId, rows[0].attemptId);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("provider native cost has precedence, including an explicit zero", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotroute-ledger-"));
  const filePath = path.join(dir, "calls.jsonl");
  const ledger = new CallLedger({ filePath });
  const row = ledger.append({
    runId: "r", taskId: "t", sessionId: "s", callId: "c", strategyVersion: "v",
    baselineCommit: "b", provider: "p", model: "m", role: "judge", attemptNumber: 1,
    startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:00.001Z",
    status: "succeeded", usage: { nativeCost: 0 }, usageSource: "provider_reported",
  });
  ledger.dispose();
  assert.equal(row.cost, 0);
  assert.equal(row.costSource, "provider_reported");
  fs.rmSync(dir, { recursive: true, force: true });
});
