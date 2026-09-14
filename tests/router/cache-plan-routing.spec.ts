import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime, ModelRuntimeOptions } from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import { calculateInputCost, calculateCacheReadCost } from "../../src/router/utils/modelPricing.js";

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

/** Same stub but declaring an Anthropic-protocol provider. */
const anthropicRuntime: ModelRuntime = {
  ...runtime,
  getProviderProtocol() {
    return "anthropic";
  },
};

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

  // The stub provider declares an openai protocol, so the rebuild gate clears
  // the mismatched plan: cache markers never reach a non-Anthropic protocol.
  assert.equal(materialized.cachePlan, undefined);
  assert.equal(materialized.cacheBreakpoints, undefined);
  await router.shutdown();
});

test("router rebuilds cache plan for the routed model when it supports prompt caching", async () => {
  const router = createRouterRuntime(config, { modelRuntime: anthropicRuntime });
  const request: CanonicalModelRequest = {
    provider: "primary",
    model: "main",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      { role: "user", content: [{ type: "text", text: "summarize" }] },
    ],
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
    sessionId: "cache-route-rebuild",
    isMainAgent: true,
    metadata: { explicitProvider: "other", explicitModel: "fast" },
  });
  const materialized = router.materializeRequest(decision, request);

  assert.equal(materialized.cachePlan?.provider, "other");
  assert.equal(materialized.cachePlan?.model, "fast");
  assert.equal(materialized.cachePlan?.generation, 1, "generation is carried from the previous plan, not bumped");
  assert.deepEqual(materialized.cacheBreakpoints, [0, 1, 2], "breakpoints are recent3 of the final messages");
  await router.shutdown();
});

test("router keeps the legacy plan-drop behavior when cachePlanRebuild is disabled", async () => {
  const router = createRouterRuntime(
    { ...config, cachePlanRebuild: { enabled: false } },
    { modelRuntime: anthropicRuntime },
  );
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
    sessionId: "cache-route-flag-off",
    isMainAgent: true,
    metadata: { explicitProvider: "other", explicitModel: "fast" },
  });
  const materialized = router.materializeRequest(decision, request);

  // Experiment control arm: with the flag OFF (and an Anthropic-protocol
  // runtime where the rebuild would otherwise fire), the pre-rebuild drop
  // behavior is preserved byte-for-byte.
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
