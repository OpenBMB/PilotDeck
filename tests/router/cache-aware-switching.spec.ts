import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { normalizeOpenAIUsage } from "../../src/model/response/normalizeUsage.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";

const cases: Array<{
  name: string;
  uncached: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  coldInputPrice?: number;
  enabled?: boolean;
  expectedModel: "warm" | "cold";
  expectedAction?: "kept_sticky" | "switched";
}> = [
  { name: "switches when a half-cached model is more expensive", uncached: 5000, cacheRead: 5000,
    expectedModel: "cold", expectedAction: "switched" },
  { name: "does not round a ninety-percent hit rate up to full caching", uncached: 1000, cacheRead: 9000,
    coldInputPrice: 1.5, expectedModel: "cold", expectedAction: "switched" },
  { name: "preserves cache savings with zero uncached input and cache writes", uncached: 0,
    cacheRead: 9000, cacheWrite: 1000, expectedModel: "warm", expectedAction: "kept_sticky" },
  { name: "preserves fully cached input without counting output in the denominator", uncached: 0,
    cacheRead: 10000, output: 20000, expectedModel: "warm", expectedAction: "kept_sticky" },
  { name: "counts cache writes in total input", uncached: 1000, cacheRead: 5000, cacheWrite: 4000,
    expectedModel: "cold", expectedAction: "switched" },
  { name: "uses the new selection when cache fields are absent", uncached: 10000, expectedModel: "cold" },
  { name: "uses the new selection with zero cache reads", uncached: 10000, cacheRead: 0,
    expectedModel: "cold" },
  { name: "handles zero total input", uncached: 0, cacheRead: 0, cacheWrite: 0, expectedModel: "cold" },
  { name: "honors disabled cache-aware switching", uncached: 0, cacheRead: 10000, enabled: false,
    expectedModel: "cold" },
];

for (const fixture of cases) {
  test(`cache-aware routing ${fixture.name}`, async t => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: fixture.uncached + (fixture.cacheRead ?? 0) + (fixture.cacheWrite ?? 0),
      completion_tokens: fixture.output ?? 10,
      prompt_tokens_details: { cached_tokens: fixture.cacheRead, cache_write_tokens: fixture.cacheWrite },
    })!;
    let judgeCalls = 0;
    let executionCalls = 0;
    const runtime: ModelRuntime = {
      async *stream() {
        executionCalls++;
        yield { type: "text_delta", text: "Synthetic answer" };
        yield { type: "usage", usage };
        yield { type: "message_end", finishReason: "stop" };
      },
      async complete() {
        const tier = ++judgeCalls === 1 ? "reasoning" : "simple";
        return { role: "assistant", content: [{ type: "text", text: `<tier>${tier}</tier>` }], finishReason: "stop" };
      },
      getCapabilities() {
        return { supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false,
          supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: true,
          supportsPromptCache: true, maxContextTokens: 100000, maxOutputTokens: 1024 };
      },
      getMultimodal() { return { input: ["text"] }; },
      getProviderProtocol() { return "openai"; },
      getProviderBaseUrl() { return "https://example.com"; },
    };
    const router = createRouterRuntime({
      enabled: true,
      scenarios: { default: { id: "primary/warm", provider: "primary", model: "warm" } },
      zeroUsageRetry: { enabled: false, maxAttempts: 1 },
      tokenSaver: {
        enabled: true, defaultTier: "simple", judgeTimeoutMs: 1000,
        judge: { id: "primary/judge", provider: "primary", model: "judge" },
        tiers: {
          reasoning: { model: { id: "primary/warm", provider: "primary", model: "warm" } },
          simple: { model: { id: "primary/cold", provider: "primary", model: "cold" } },
        },
        cacheAwareSwitching: { enabled: fixture.enabled ?? true, minSavingsRatio: 0 },
      },
      // Synthetic prices per million tokens make the two choices distinguishable.
      stats: { enabled: false, modelPricing: {
        "primary/warm": { input: 10, cacheRead: 1 },
        "primary/cold": { input: fixture.coldInputPrice ?? 3 },
      } },
    }, { modelRuntime: runtime, judgeRuntime: runtime });
    t.after(() => router.shutdown());
    const request: CanonicalModelRequest = { provider: "primary", model: "warm", messages: [
      { role: "user", content: [{ type: "text", text: "Synthetic reference context. ".repeat(100) }] },
    ] };
    const sessionId = "cache-aware-test";
    const initial = await router.decide({ sessionId, isMainAgent: true, request });
    assert.equal(initial.model, "warm");
    for await (const event of router.execute(initial, request, { sessionId, turnId: "initial-turn" })) {
      assert.notEqual(event.type, "error");
    }
    assert.equal(executionCalls, 1);

    const previous = router.invalidateSticky(sessionId);
    assert.equal(previous.previousModel, "warm");
    const decision = await router.decide({ sessionId, isMainAgent: true, metadata: previous,
      request: { ...request, messages: [...request.messages,
        { role: "assistant", content: [{ type: "text", text: "Synthetic answer" }] },
        { role: "user", content: [{ type: "text", text: "Synthetic next task" }] },
      ] },
    });
    assert.equal(judgeCalls, 2, "The new user turn must be reclassified");
    assert.equal(decision.provider, "primary");
    assert.equal(decision.model, fixture.expectedModel);
    assert.equal(decision.mutations.cacheAwareSwitch?.action, fixture.expectedAction);
  });
}
