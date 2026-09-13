import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TokenStatsCollector } from "../../src/router/stats/TokenStatsCollector.js";

test("model usage aggregates provider/model tokens, cost, and roles across a stats rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-model-usage-"));
  const config = { enabled: true, filePath: join(directory, "router-stats.json") };
  const first = new TokenStatsCollector(config);

  try {
    first.observe({
      sessionId: "sdk:one",
      turnId: "turn-1",
      scenarioType: "default" as any,
      resolvedFrom: "scenario" as any,
      provider: "test",
      model: "model-a",
      role: "main",
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 18, nativeCost: 0.003 },
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
    });
    first.observe({
      sessionId: "sdk:one",
      turnId: "turn-2",
      scenarioType: "default" as any,
      resolvedFrom: "scenario" as any,
      provider: "test",
      model: "model-a",
      role: "subagent",
      usage: { inputTokens: 2, outputTokens: 5, totalTokens: 7, nativeCost: 0.004 },
      startedAt: "2026-01-01T00:00:02.000Z",
      endedAt: "2026-01-01T00:00:03.000Z",
    });
    first.observe({
      sessionId: "sdk:two",
      turnId: "turn-3",
      scenarioType: "default" as any,
      resolvedFrom: "scenario" as any,
      provider: "other",
      model: "model-b",
      role: "main",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, nativeCost: 0.002 },
      startedAt: "2026-01-01T00:00:04.000Z",
      endedAt: "2026-01-01T00:00:05.000Z",
    });

    const expected = [{
      provider: "test",
      model: "model-a",
      totalRequests: 2,
      inputTokens: 12,
      outputTokens: 9,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 25,
      totalCost: 0.007,
      costSources: { provider_reported: 2 },
      roles: {
        main: {
          totalRequests: 1,
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
          totalTokens: 18,
          totalCost: 0.003,
          costSources: { provider_reported: 1 },
        },
        subagent: {
          totalRequests: 1,
          inputTokens: 2,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 7,
          totalCost: 0.004,
          costSources: { provider_reported: 1 },
        },
      },
    }];
    assert.deepEqual(first.modelUsageSnapshot("sdk:one"), expected);
    assert.deepEqual(first.modelUsageSnapshot().map(({ provider, model, totalRequests }) => ({ provider, model, totalRequests })), [
      { provider: "other", model: "model-b", totalRequests: 1 },
      { provider: "test", model: "model-a", totalRequests: 2 },
    ]);
  } finally {
    first.dispose();
  }

  try {
    const restored = new TokenStatsCollector(config);
    try {
      assert.deepEqual(restored.modelUsageSnapshot("sdk:one"), [{
        provider: "test",
        model: "model-a",
        totalRequests: 2,
        inputTokens: 12,
        outputTokens: 9,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        totalTokens: 25,
        totalCost: 0.007,
        costSources: { provider_reported: 2 },
        roles: {
          main: {
            totalRequests: 1,
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            totalTokens: 18,
            totalCost: 0.003,
            costSources: { provider_reported: 1 },
          },
          subagent: {
            totalRequests: 1,
            inputTokens: 2,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 7,
            totalCost: 0.004,
            costSources: { provider_reported: 1 },
          },
        },
      }]);
    } finally {
      restored.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("model usage exposes configured price-table estimates separately from provider-reported costs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-model-usage-cost-source-"));
  const collector = new TokenStatsCollector({
    enabled: true,
    filePath: join(directory, "router-stats.json"),
    modelPricing: { "test/model-a": { input: 2, output: 4, cacheRead: 1 } },
  });

  try {
    collector.observe({
      sessionId: "sdk:priced",
      scenarioType: "default" as any,
      resolvedFrom: "scenario" as any,
      provider: "test",
      model: "model-a",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 },
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
    });

    assert.deepEqual(collector.snapshot().costSources, { configured_price: 1 });
    assert.deepEqual(collector.modelUsageSnapshot("sdk:priced")[0]?.costSources, { configured_price: 1 });
  } finally {
    collector.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured usage retention excludes expired records and atomically compacts the durable journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-model-usage-retention-"));
  const filePath = join(directory, "router-stats.json");
  const first = new TokenStatsCollector({ enabled: true, filePath });

  try {
    first.observe({
      sessionId: "sdk:expired",
      scenarioType: "default" as any,
      resolvedFrom: "scenario" as any,
      provider: "test",
      model: "model-a",
      usage: { inputTokens: 1, totalTokens: 1 },
      startedAt: "2000-01-01T00:00:00.000Z",
      endedAt: "2000-01-01T00:00:01.000Z",
    });
    first.observe({
      sessionId: "sdk:current",
      scenarioType: "default" as any,
      resolvedFrom: "scenario" as any,
      provider: "test",
      model: "model-a",
      usage: { inputTokens: 2, totalTokens: 2 },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
  } finally {
    first.dispose();
  }

  const retained = new TokenStatsCollector({ enabled: true, filePath, retentionMs: 60_000 });
  try {
    assert.equal(retained.snapshot().totalRequests, 1);
    assert.equal(retained.sessionSnapshot("sdk:expired"), undefined);
    const journal = (await readFile(join(directory, "stats.jsonl"), "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(journal.length, 1, JSON.stringify(journal));
    assert.equal(journal[0]?.sessionId, "sdk:current");
  } finally {
    retained.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
