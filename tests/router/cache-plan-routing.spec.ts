import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CanonicalModelRequest, ModelRuntime, ModelRuntimeOptions } from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import { calculateInputCost, calculateCacheReadCost } from "../../src/router/utils/modelPricing.js";
import { currentRequestContext, requestContextHeaders, withRequestContext } from "../../src/network/requestContext.js";

const capabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: false,
  supportsThinking: false,
  supportsJsonSchema: false,
  supportsSystemPrompt: true,
  supportsPromptCache: true,
  maxContextTokens: 8192,
  maxOutputTokens: 1024,
};

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "primary/main", provider: "primary", model: "main" } },
  zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  stats: { enabled: false },
};

const runtime: ModelRuntime = {
  async *stream(_request: CanonicalModelRequest, _options?: ModelRuntimeOptions) {},
  async complete() {
    throw new Error("not used");
  },
  getCapabilities() {
    return capabilities;
  },
  getMultimodal() {
    return { input: ["text"] };
  },
  getProviderProtocol() {
    return "openai";
  },
  getProviderBaseUrl(provider: string) {
    return `https://${provider}.invalid`;
  },
};

test("compaction model headers retain the originating turn without leaking concurrent context", async () => {
  const home = mkdtempSync(join(tmpdir(), "pilotdeck-compaction-headers-"));
  const saved = { home: process.env.PILOT_HOME, mode: process.env.PILOTDECK_REQUEST_HEADERS };
  process.env.PILOT_HOME = home;
  process.env.PILOTDECK_REQUEST_HEADERS = "full";
  const seen: Record<string, string>[] = [];
  const router = createRouterRuntime(config, { modelRuntime: { ...runtime,
    async *stream(_request, options) {
      await new Promise(resolve => setTimeout(resolve, 2));
      seen.push(requestContextHeaders(options?.requestContext));
    },
  } });
  const request: CanonicalModelRequest = { provider: "primary", model: "main", messages: [{ role: "user", content: [{ type: "text", text: "Summarize" }] }] };
  try {
    await Promise.all(["turn-a", "turn-b"].map(turnId => withRequestContext({ turnId, sessionId: turnId }, async () => {
      for await (const _event of router.stream(request, { sessionId: turnId, turnId: "compact", isMainAgent: false })) { /* drain */ }
      assert.equal(currentRequestContext().turnId, turnId);
    })));
    for (const turnId of ["turn-a", "turn-b"]) {
      const expected = requestContextHeaders({ turnId, sessionId: turnId });
      const actual = seen.find(headers => headers["x-pilotdeck-session-id"] === expected["x-pilotdeck-session-id"]);
      assert.equal(actual?.["x-pilotdeck-turn-id"], expected["x-pilotdeck-turn-id"]);
      assert.equal(actual?.["x-pilotdeck-purpose"], "compaction");
    }
    for await (const _event of router.stream(request, { sessionId: "manual", turnId: "compact", isMainAgent: false })) { /* drain */ }
    assert.equal(seen.at(-1)?.["x-pilotdeck-turn-id"], undefined);
    assert.equal(seen.at(-1)?.["x-pilotdeck-purpose"], "compaction");
    await withRequestContext({ turnId: "outer-turn" }, async () => {
      for await (const _event of router.stream(request, { sessionId: "normal", turnId: "real-turn", isMainAgent: false })) { /* drain */ }
    });
    assert.equal(seen.at(-1)?.["x-pilotdeck-turn-id"], requestContextHeaders({ turnId: "real-turn" })["x-pilotdeck-turn-id"]);
    assert.equal(seen.at(-1)?.["x-pilotdeck-purpose"], "conversation");
  } finally {
    await router.shutdown();
    if (saved.home === undefined) delete process.env.PILOT_HOME; else process.env.PILOT_HOME = saved.home;
    if (saved.mode === undefined) delete process.env.PILOTDECK_REQUEST_HEADERS; else process.env.PILOTDECK_REQUEST_HEADERS = saved.mode;
    rmSync(home, { recursive: true, force: true });
  }
});

test("router drops cache plan when explicit routing changes provider or model", async () => {
  const router = createRouterRuntime(config, { modelRuntime: runtime });
  const request: CanonicalModelRequest = {
    provider: "primary",
    model: "main",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    cacheBreakpoints: [0],
    cachePlan: {
      provider: "primary",
      model: "main",
      system: true,
      tools: false,
      messages: [0],
      fingerprint: "primary-main",
      generation: 1,
    },
  };

  const decision = await router.decide({
    request,
    sessionId: "cache-route",
    isMainAgent: true,
    metadata: { explicitProvider: "other", explicitModel: "fast" },
  });
  const materialized = router.materializeRequest(decision, request);

  assert.equal(materialized.cachePlan, undefined);
  assert.equal(materialized.cacheBreakpoints, undefined);
  await router.shutdown();
});

test("pricing unit is metadata and does not change cost calculations", () => {
  const pricing = {
    "primary/main": { input: 2, cacheRead: 0.5, unit: "¥/百万 Token" as const },
  };

  assert.equal(calculateInputCost(1_000_000, "primary", "main", pricing), 2);
  assert.equal(calculateCacheReadCost(1_000_000, "primary", "main", pricing), 0.5);
});

test("router stats prefer an explicit baseline model over the scenario default", async () => {
  const router = createRouterRuntime({
    ...config,
    stats: {
      enabled: true,
      filePath: `/tmp/pilotdeck-router-baseline-${process.pid}-${Math.random().toString(36).slice(2)}/stats.json`,
      baselineModel: { provider: "baseline", model: "model" },
      modelPricing: {
        "primary/main": { input: 1 },
        "baseline/model": { input: 3 },
      },
    },
  }, { modelRuntime: runtime });
  router.stats.observe({
    sessionId: "baseline-test",
    scenarioType: "default",
    resolvedFrom: "scenario",
    provider: "primary",
    model: "main",
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
  });
  assert.equal(router.stats.snapshot().totalBaselineCost, 3);
  await router.shutdown();
});
