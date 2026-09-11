import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TokenStatsCollector, type RouterStatsRecord } from "../../src/router/stats/TokenStatsCollector.js";

function record(overrides: Partial<RouterStatsRecord> = {}): RouterStatsRecord {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    projectPath: "/workspace/project",
    scenarioType: "default",
    resolvedFrom: "tokenSaver",
    provider: "actual",
    model: "model",
    tier: "medium",
    role: "main",
    usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    startedAt: "2026-09-11T10:00:00.000Z",
    endedAt: "2026-09-11T10:00:01.000Z",
    ...overrides,
  };
}

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-router-stats-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("aggregates task-card, judge, guard, bypass, and net saved metrics", async () => {
  await withTempDir(async dir => {
    const collector = new TokenStatsCollector({
      enabled: true,
      filePath: join(dir, "stats.json"),
      baselineModel: { provider: "baseline", model: "model" },
      modelPricing: {
        "actual/model": { input: 1 },
        "baseline/model": { input: 3 },
      },
    });
    collector.observe(record({
      routing: {
        taskCardRoute: {
          shortCircuited: true,
          hasCard: true,
          judgeCalled: false,
          reason: "continuation",
        },
        cacheAwareSwitch: {
          action: "kept_sticky",
          from: "actual/model",
          to: "next/model",
          cachedCost: 1,
          prefillCost: 2,
          estimatedInputTokens: 1_000_000,
          direction: "upgrade",
          policy: "guard",
          evidence: "verification_failed",
        },
      },
      judge: { called: true, attempts: 2, usage: { inputTokens: 10 }, cost: 0.25 },
    }));
    collector.observe(record({
      turnId: "turn-2",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      routing: {
        taskCardRoute: {
          shortCircuited: false,
          hasCard: false,
          judgeCalled: true,
          isNewTask: false,
          reason: "task_done_reset",
        },
        cacheAwareSwitch: {
          action: "bypassed_by_evidence",
          from: "actual/model",
          to: "next/model",
          cachedCost: 1,
          prefillCost: 5,
          estimatedInputTokens: 1_000_000,
          direction: "upgrade",
          policy: "exempt",
          evidence: "verification_failed",
        },
      },
      judge: { called: false },
    }));

    assert.deepEqual(collector.snapshot(), {
      totalRequests: 2,
      totalInputTokens: 1_000_000,
      totalOutputTokens: 0,
      totalCost: 1,
      totalBaselineCost: 3,
      totalSavedCost: 2,
      totalJudgeCalls: 1,
      totalJudgeCost: 0.25,
      totalShortCircuits: 1,
      totalTaskCardRequests: 1,
      totalNewTaskResets: 1,
      totalGuardSavedCost: 1,
      totalGuardBypassCost: 4,
      totalNetSavedCost: -1.25,
      perScenario: { default: 2 },
      perModel: { "actual/model": 2 },
      perProvider: { actual: 2 },
      perTier: { medium: 2 },
      perRole: { main: 2 },
    });

    collector.dispose();
    const persisted = await readFile(join(dir, "stats.jsonl"), "utf8");
    assert.match(persisted, /"taskCardRoute"/);
    assert.match(persisted, /"judge"/);
    assert.match(persisted, /"bypassed_by_evidence"/);
  });
});

test("replays legacy and malformed optional JSONL fields with zero routing metrics", async () => {
  await withTempDir(async dir => {
    await writeFile(join(dir, "stats.jsonl"), [
      JSON.stringify(record({ cost: { input: 1, output: 0, cacheRead: 0, total: 1 }, baselineCost: 1 })),
      JSON.stringify(record({
        sessionId: "legacy-malformed",
        cost: { input: 1, output: 0, cacheRead: 0, total: 1 },
        baselineCost: 1,
        routing: "invalid" as unknown as RouterStatsRecord["routing"],
        judge: ["invalid"] as unknown as RouterStatsRecord["judge"],
      })),
      "{malformed-json",
      "",
    ].join("\n"), "utf8");

    const collector = new TokenStatsCollector({
      enabled: true,
      filePath: join(dir, "stats.json"),
      baselineModel: { provider: "actual", model: "model" },
      modelPricing: { "actual/model": { input: 1 } },
    });
    const snapshot = collector.snapshot();

    assert.equal(snapshot.totalRequests, 2);
    assert.equal(snapshot.totalCost, 2);
    assert.equal(snapshot.totalJudgeCalls, 0);
    assert.equal(snapshot.totalJudgeCost, 0);
    assert.equal(snapshot.totalShortCircuits, 0);
    assert.equal(snapshot.totalTaskCardRequests, 0);
    assert.equal(snapshot.totalNewTaskResets, 0);
    assert.equal(snapshot.totalGuardSavedCost, 0);
    assert.equal(snapshot.totalGuardBypassCost, 0);
    assert.equal(snapshot.totalNetSavedCost, 0);
    collector.dispose();
  });
});
