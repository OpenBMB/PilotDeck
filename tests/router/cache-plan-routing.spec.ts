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

test("Gateway model policy rejects a selected model before invoking a provider", async () => {
  let invocations = 0;
  const guardedRuntime: ModelRuntime = {
    ...runtime,
    async *stream() {
      invocations += 1;
      yield { type: "request_started", provider: "primary", model: "main" } as any;
    },
  };
  const router = createRouterRuntime(config, {
    modelRuntime: guardedRuntime,
    isModelAllowed: () => false,
  });
  const request: CanonicalModelRequest = {
    provider: "primary",
    model: "main",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const decision = await router.decide({ request, sessionId: "model-policy-denied", isMainAgent: true });

  await assert.rejects(async () => {
    for await (const _event of router.execute(decision, request, {
      sessionId: "model-policy-denied",
      turnId: "turn-1",
    })) { /* consume */ }
  }, (error: any) => error?.code === "MODEL_POLICY_DENIED");
  assert.equal(invocations, 0);
  await router.shutdown();
});

test("Gateway model policy excludes disallowed fallback attempts", async () => {
  const invocations: string[] = [];
  const fallbackRuntime: ModelRuntime = {
    ...runtime,
    async *stream(request) {
      invocations.push(`${request.provider}/${request.model}`);
      yield { type: "request_started", provider: request.provider, model: request.model } as any;
      yield {
        type: "error",
        error: {
          provider: request.provider,
          model: request.model,
          protocol: "openai",
          code: "rate_limit",
          message: "retryable test error",
          retryable: true,
        },
      } as any;
    },
  };
  const router = createRouterRuntime({
    ...config,
    fallback: {
      default: [{ id: "secondary/backup", provider: "secondary", model: "backup" }],
    },
  }, {
    modelRuntime: fallbackRuntime,
    isModelAllowed: ({ provider, model }) => provider === "primary" && model === "main",
  });
  const request: CanonicalModelRequest = {
    provider: "primary",
    model: "main",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const decision = await router.decide({ request, sessionId: "model-policy-fallback", isMainAgent: true });
  for await (const _event of router.execute(decision, request, {
    sessionId: "model-policy-fallback",
    turnId: "turn-1",
  })) { /* consume */ }

  assert.deepEqual(invocations, ["primary/main"]);
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
