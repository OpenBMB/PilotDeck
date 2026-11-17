import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime, ModelRuntimeOptions } from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

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

const modelRuntime: ModelRuntime = {
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

test("cache-aware switching never blocks a judge-requested tier upgrade", async () => {
  const decision = await decideAcrossTurns({
    previousTier: "simple",
    nextTier: "reasoning",
    modelPricing: {
      "test/simple": { input: 1, cacheRead: 0.1 },
      "test/reasoning": { input: 10, cacheRead: 1 },
    },
  });

  assert.equal(decision.tokenSaverTier, "reasoning");
  assert.equal(decision.model, "reasoning");
  assert.equal(decision.mutations.cacheAwareSwitch, undefined);
});

test("cache-aware switching can retain the current model on a tier downgrade", async () => {
  const decision = await decideAcrossTurns({
    previousTier: "reasoning",
    nextTier: "simple",
    modelPricing: {
      "test/reasoning": { input: 10, cacheRead: 0.1 },
      "test/simple": { input: 1, cacheRead: 0.5 },
    },
  });

  assert.equal(decision.tokenSaverTier, "reasoning");
  assert.equal(decision.model, "reasoning");
  assert.equal(decision.mutations.cacheAwareSwitch?.action, "kept_sticky");
});

test("cache-aware switching still allows a cost-effective tier downgrade", async () => {
  const decision = await decideAcrossTurns({
    previousTier: "reasoning",
    nextTier: "simple",
    modelPricing: {
      "test/reasoning": { input: 10, cacheRead: 2 },
      "test/simple": { input: 1, cacheRead: 0.5 },
    },
  });

  assert.equal(decision.tokenSaverTier, "simple");
  assert.equal(decision.model, "simple");
  assert.equal(decision.mutations.cacheAwareSwitch?.action, "switched");
});

async function decideAcrossTurns(input: {
  previousTier: "simple" | "medium" | "complex" | "reasoning";
  nextTier: "simple" | "medium" | "complex" | "reasoning";
  modelPricing: NonNullable<RouterConfig["stats"]>["modelPricing"];
}) {
  const judgeTiers = [input.previousTier, input.nextTier];
  let judgeCall = 0;
  const judgeRuntime = {
    async complete() {
      const tier = judgeTiers[judgeCall++];
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `<tier>${tier}</tier>` }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;

  const router = createRouterRuntime(createConfig(input.modelPricing), {
    modelRuntime,
    judgeRuntime,
  });

  try {
    const firstDecision = await router.decide({
      sessionId: "cache-aware-tier-direction",
      isMainAgent: true,
      request: createRequest([
        { role: "user", content: [{ type: "text", text: "first task" }] },
      ]),
    });
    assert.equal(firstDecision.tokenSaverTier, input.previousTier);

    router.observeUsage("cache-aware-tier-direction", {
      inputTokens: 1_000,
      outputTokens: 10,
      cacheReadTokens: 1_000,
      totalTokens: 2_010,
    });
    const previous = router.invalidateSticky("cache-aware-tier-direction");

    const decision = await router.decide({
      sessionId: "cache-aware-tier-direction",
      isMainAgent: true,
      metadata: {
        previousTier: previous.previousTier,
        previousProvider: previous.previousProvider,
        previousModel: previous.previousModel,
      },
      request: createRequest([
        { role: "user", content: [{ type: "text", text: "first task" }] },
        { role: "assistant", content: [{ type: "text", text: "first response" }] },
        { role: "user", content: [{ type: "text", text: "second task" }] },
      ]),
    });
    assert.equal(judgeCall, 2);
    return decision;
  } finally {
    await router.shutdown();
  }
}

function createRequest(messages: CanonicalModelRequest["messages"]): CanonicalModelRequest {
  return {
    provider: "test",
    model: "default",
    messages,
  };
}

function createConfig(
  modelPricing: NonNullable<RouterConfig["stats"]>["modelPricing"],
): RouterConfig {
  const tierModel = (tier: string) => ({
    model: { id: `test/${tier}`, provider: "test", model: tier },
  });

  return {
    enabled: true,
    scenarios: {
      default: { id: "test/default", provider: "test", model: "default" },
    },
    tokenSaver: {
      enabled: true,
      judge: { id: "test/judge", provider: "test", model: "judge" },
      defaultTier: "medium",
      judgeTimeoutMs: 5_000,
      tiers: {
        simple: tierModel("simple"),
        medium: tierModel("medium"),
        complex: tierModel("complex"),
        reasoning: tierModel("reasoning"),
      },
      cacheAwareSwitching: { enabled: true, minSavingsRatio: 0 },
    },
    stats: { enabled: false, modelPricing },
  };
}
