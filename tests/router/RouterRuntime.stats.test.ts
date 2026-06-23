import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type {
  CanonicalModelEvent,
  CanonicalModelResponse,
  ModelRuntime,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterModelRef, RouterStatsConfig } from "../../src/router/config/schema.js";

const cheapDefaultModel: RouterModelRef = {
  id: "cheap/c",
  provider: "cheap",
  model: "c",
};

const expensiveBaselineModel: RouterModelRef = {
  id: "expensive/e",
  provider: "expensive",
  model: "e",
};

function createRuntime(): ModelRuntime {
  return {
    async *stream(): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(): Promise<CanonicalModelResponse> {
      return {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
      };
    },
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderBaseUrl: () => undefined,
  };
}

function statsConfig(extra: Partial<RouterStatsConfig> = {}): RouterStatsConfig {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-router-stats-"));
  return {
    enabled: true,
    filePath: join(dir, "stats.jsonl"),
    modelPricing: {
      "cheap/c": { input: 1, output: 0 },
      "expensive/e": { input: 10, output: 0 },
    },
    ...extra,
  };
}

function cleanupStats(config: RouterStatsConfig): void {
  if (config.filePath) {
    rmSync(dirname(config.filePath), { recursive: true, force: true });
  }
}

function observeOneRequest(
  router: ReturnType<typeof createRouterRuntime>,
  model: RouterModelRef,
): void {
  router.stats.observe({
    sessionId: "session-1",
    turnId: "turn-1",
    scenarioType: "default",
    resolvedFrom: "scenario",
    provider: model.provider,
    model: model.model,
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
    },
    startedAt: "2026-06-23T00:00:00.000Z",
    endedAt: "2026-06-23T00:00:01.000Z",
  });
}

test("explicit stats baseline wins over the default scenario baseline", async () => {
  const stats = statsConfig({ baselineModel: expensiveBaselineModel });
  const router = createRouterRuntime(
    {
      scenarios: { default: cheapDefaultModel },
      stats,
    },
    { modelRuntime: createRuntime() },
  );

  try {
    observeOneRequest(router, cheapDefaultModel);

    const record = router.stats.recent(1)[0];
    assert.equal(record?.cost?.total, 1);
    assert.equal(record?.baselineCost, 10);
    assert.equal(router.stats.snapshot().totalSavedCost, 9);
  } finally {
    await router.shutdown();
    cleanupStats(stats);
  }
});

test("default scenario remains the stats baseline when no explicit baseline is configured", async () => {
  const stats = statsConfig();
  const router = createRouterRuntime(
    {
      scenarios: { default: cheapDefaultModel },
      stats,
    },
    { modelRuntime: createRuntime() },
  );

  try {
    observeOneRequest(router, expensiveBaselineModel);

    const record = router.stats.recent(1)[0];
    assert.equal(record?.cost?.total, 10);
    assert.equal(record?.baselineCost, 1);
    assert.equal(router.stats.snapshot().totalSavedCost, -9);
  } finally {
    await router.shutdown();
    cleanupStats(stats);
  }
});

test("explicit stats baseline is used when no default scenario exists", async () => {
  const stats = statsConfig({ baselineModel: expensiveBaselineModel });
  const router = createRouterRuntime(
    {
      stats,
    },
    { modelRuntime: createRuntime() },
  );

  try {
    observeOneRequest(router, cheapDefaultModel);

    const record = router.stats.recent(1)[0];
    assert.equal(record?.cost?.total, 1);
    assert.equal(record?.baselineCost, 10);
    assert.equal(router.stats.snapshot().totalSavedCost, 9);
  } finally {
    await router.shutdown();
    cleanupStats(stats);
  }
});
