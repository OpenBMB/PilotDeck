import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { normalizeOpenAIUsage } from "../../src/model/response/normalizeUsage.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterTurnRouting } from "../../src/router/protocol/decision.js";
import type { RouterPricingUnit } from "../../src/router/utils/modelPricing.js";

const cases: Array<{
  name: string;
  uncached: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  warmInputPrice?: number;
  coldInputPrice?: number;
  coldUnit?: RouterPricingUnit;
  minSavingsRatio?: number;
  missingWarmInputPrice?: boolean;
  sharedModelName?: boolean;
  image?: boolean;
  upgrade?: boolean;
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
  { name: "switches to cheaper input when cache fields are absent", uncached: 10000,
    expectedModel: "cold", expectedAction: "switched" },
  { name: "keeps the cheaper current model with zero cache reads", uncached: 10000, cacheRead: 0,
    warmInputPrice: 2, expectedModel: "warm", expectedAction: "kept_sticky" },
  { name: "switches to cheaper input even with zero observed tokens", uncached: 0, cacheRead: 0, cacheWrite: 0,
    expectedModel: "cold", expectedAction: "switched" },
  { name: "keeps configured prices scoped to the provider of a same-named model", uncached: 10000, cacheRead: 0,
    sharedModelName: true, expectedModel: "cold", expectedAction: "switched" },
  { name: "keeps the current model when cold input savings are below the configured threshold", uncached: 10000,
    warmInputPrice: 3.1, minSavingsRatio: 0.05, expectedModel: "warm", expectedAction: "kept_sticky" },
  { name: "skips comparison across currencies", uncached: 10000, cacheRead: 10000, coldUnit: "¥/百万 Token",
    expectedModel: "cold" },
  { name: "skips comparison when a partial configured price omits input", uncached: 10000,
    missingWarmInputPrice: true, expectedModel: "cold" },
  { name: "selects a vision model despite cheaper cached input on a text model", uncached: 0, cacheRead: 10000,
    image: true, expectedModel: "cold" },
  { name: "cannot keep a cheaper model configured only below the judged tier", uncached: 0, cacheRead: 10000,
    upgrade: true, expectedModel: "cold" },
];

for (const fixture of cases) {
  test(`cache-aware routing ${fixture.name}`, async t => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: fixture.uncached + (fixture.cacheRead ?? 0) + (fixture.cacheWrite ?? 0),
      completion_tokens: fixture.output ?? 10,
      prompt_tokens_details: { cached_tokens: fixture.cacheRead, cache_write_tokens: fixture.cacheWrite },
    })!;
    const warmTier = fixture.upgrade ? "simple" : "reasoning";
    const coldTier = fixture.upgrade ? "reasoning" : "simple";
    const warm = fixture.sharedModelName ? { id: "alpha/gpt-5", provider: "alpha", model: "gpt-5" }
      : { id: "primary/warm", provider: "primary", model: "warm" };
    const cold = fixture.sharedModelName ? { id: "zeta/gpt-5", provider: "zeta", model: "gpt-5" }
      : { id: "primary/cold", provider: "primary", model: "cold" };
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
        const tier = ++judgeCalls === 1 ? warmTier : coldTier;
        return { role: "assistant", content: [{ type: "text", text: `<tier>${tier}</tier>` }], finishReason: "stop" };
      },
      getCapabilities() {
        return { supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false,
          supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: true,
          supportsPromptCache: true, maxContextTokens: 100000, maxOutputTokens: 1024 };
      },
      getMultimodal(provider, model) { return { input: provider === cold.provider && model === cold.model ? ["text", "image"] : ["text"] }; },
      getProviderProtocol() { return "openai"; },
      getProviderBaseUrl() { return "https://example.com"; },
    };
    const router = createRouterRuntime({
      enabled: true,
      scenarios: { default: warm },
      zeroUsageRetry: { enabled: false, maxAttempts: 1 },
      tokenSaver: {
        enabled: true, defaultTier: "simple", judgeTimeoutMs: 1000,
        judge: { id: "primary/judge", provider: "primary", model: "judge" },
        tiers: {
          [warmTier]: { model: warm },
          [coldTier]: { model: cold },
        },
        cacheAwareSwitching: { minSavingsRatio: fixture.minSavingsRatio ?? 0 },
      },
      // Synthetic prices per million tokens make the two choices distinguishable.
      stats: { enabled: false, modelPricing: {
        [warm.id]: { input: fixture.missingWarmInputPrice ? undefined : fixture.warmInputPrice ?? 10, cacheRead: 1 },
        ...(fixture.sharedModelName ? {} : { [cold.id]: { input: fixture.coldInputPrice ?? 3, unit: fixture.coldUnit } }),
      } },
    }, { modelRuntime: runtime, judgeRuntime: runtime });
    t.after(() => router.shutdown());
    const request: CanonicalModelRequest = { provider: warm.provider, model: warm.model, messages: [
      { role: "user", content: [{ type: "text", text: "Synthetic reference context. ".repeat(100) }] },
    ] };
    const sessionId = "cache-aware-test";
    const initial = await router.decide({ sessionId, isMainAgent: true, request });
    assert.equal(initial.model, warm.model);
    for await (const event of router.execute(initial, request, { sessionId, turnId: "initial-turn" })) {
      assert.notEqual(event.type, "error");
    }
    assert.equal(executionCalls, 1);

    const previous = router.invalidateSticky(sessionId);
    assert.equal(previous.previousModel, warm.model);
    const decision = await router.decide({ sessionId, isMainAgent: true, metadata: previous,
      request: { ...request, messages: [...request.messages,
        { role: "assistant", content: [{ type: "text", text: "Synthetic answer" }] },
        { role: "user", content: [{ type: "text", text: "Synthetic next task" },
          ...(fixture.image ? [{ type: "image" as const, source: "base64" as const, mimeType: "image/png", data: "AA==", bytes: 1 }] : []),
        ] },
      ] },
    });
    assert.equal(judgeCalls, 2, "The new user turn must be reclassified");
    const expected = fixture.expectedModel === "warm" ? warm : cold;
    assert.equal(decision.provider, expected.provider);
    assert.equal(decision.model, expected.model);
    assert.equal(decision.tokenSaverTier, coldTier);
    assert.equal(decision.mutations.cacheAwareSwitch?.action, fixture.expectedAction);
  });
}

const a = { id: "alpha/primary", provider: "alpha", model: "primary" };
const b = { id: "beta/warm", provider: "beta", model: "warm" };
const c = { id: "gamma/other", provider: "gamma", model: "other" };
const warmUsage = { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 9000 };

function failoverFixture(t: test.TestContext, options: { reportedUsage?: boolean; lastAttempt?: "failure" | "empty" | "incomplete" | "truncated" } = {}) {
  const attempts: string[] = [];
  let judgeCalls = 0;
  const runtime: ModelRuntime = {
    async *stream(request) {
      const id = `${request.provider}/${request.model}`;
      attempts.push(id);
      if (request.metadata?.syntheticFailover && id === a.id) {
        yield { type: "error", error: {
          provider: a.provider, protocol: "openai", code: "rate_limit_error", message: "Synthetic rate limit", retryable: true,
        } };
        return;
      }
      if (id === c.id && options.lastAttempt === "failure") {
        yield { type: "error", error: {
          provider: c.provider, protocol: "openai", code: "model_not_found", message: "Synthetic failure", retryable: false,
        } };
        return;
      }
      if (id === c.id && options.lastAttempt === "empty") {
        yield { type: "usage", usage: warmUsage };
        yield { type: "message_end", finishReason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Synthetic answer" };
      if (id === c.id && options.lastAttempt === "incomplete") return;
      if (request.metadata?.syntheticAuxiliary) {
        yield { type: "usage", usage: { inputTokens: 10000, outputTokens: 10 } };
      } else if (options.reportedUsage !== false) {
        yield { type: "usage", usage: warmUsage };
      }
      yield { type: "message_end", finishReason: id === c.id && options.lastAttempt === "truncated" ? "length" : "stop" };
    },
    async complete() {
      judgeCalls++;
      return { role: "assistant", content: [{ type: "text", text: "<tier>simple</tier>" }], finishReason: "stop" };
    },
    getCapabilities: () => ({
      supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false, supportsThinking: false,
      supportsJsonSchema: false, supportsSystemPrompt: true, supportsPromptCache: true, maxContextTokens: 100000, maxOutputTokens: 1024,
    }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.test",
  };
  const router = createRouterRuntime({
    scenarios: { default: b },
    tokenSaver: {
      enabled: true, judge: a, defaultTier: "simple", judgeTimeoutMs: 1000,
      subagent: { policy: "skip" },
      tiers: { simple: { model: a }, medium: { model: b }, complex: { model: c } },
    },
    stats: { enabled: false, modelPricing: { [a.id]: { input: 3 }, [b.id]: { input: 10, cacheRead: 1 } } },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  }, { modelRuntime: runtime, modelPool: [a, b, c] });
  t.after(() => router.shutdown());
  const request: CanonicalModelRequest = {
    provider: a.provider, model: a.model,
    messages: [{ role: "user", content: [{ type: "text", text: "Synthetic task. ".repeat(100) }] }],
  };
  const scope = { sessionId: "cache-failover", isMainAgent: true };
  const consume = async (events: ReturnType<typeof router.stream>) => {
    const emitted = [];
    for await (const event of events) emitted.push(event);
    return emitted;
  };

  return {
    router, request, scope, attempts,
    get judgeCalls() { return judgeCalls; },
    consume,
    async runInitialTurn() {
      const initial = await router.decide({ ...scope, request });
      assert.equal(initial.model, a.model);
      const events = await consume(router.execute(initial,
        { ...request, metadata: { syntheticFailover: true } },
        { ...scope, turnId: "initial" },
      ));
      assert.ok(events.some(event => event.type === "text_delta"));
      assert.ok(events.every(event => event.type !== "error"));
      assert.deepEqual(attempts, [a.id, b.id]);
    },
    async nextDecision() {
      const previous = router.invalidateSticky(scope.sessionId);
      assert.equal(previous.previousProvider, b.provider);
      assert.equal(previous.previousModel, b.model);
      const next = { ...request, messages: [...request.messages, {
        role: "user" as const, content: [{ type: "text" as const, text: "Synthetic follow-up" }],
      }] };
      return router.decide({ ...scope, request: next, metadata: previous });
    },
  };
}

test("the next user message compares against the successful failover model and its cache usage", async t => {
  const fixture = failoverFixture(t);
  await fixture.runInitialTurn();
  const decision = await fixture.nextDecision();
  assert.equal(fixture.judgeCalls, 2);
  assert.equal(decision.tokenSaverTier, "simple");
  assert.equal(decision.provider, b.provider);
  assert.equal(decision.model, b.model);
  assert.equal(decision.mutations.cacheAwareSwitch?.from, b.id);
  assert.equal(decision.mutations.cacheAwareSwitch?.to, a.id);
  assert.equal(decision.mutations.cacheAwareSwitch?.action, "kept_sticky");
});

test("an auxiliary call on the same session and model does not replace the main cache observation", async t => {
  const fixture = failoverFixture(t);
  await fixture.runInitialTurn();
  await fixture.consume(fixture.router.stream(
    { ...fixture.request, metadata: { syntheticAuxiliary: true } },
    { ...fixture.scope, turnId: "compact", isMainAgent: false },
  ));
  assert.deepEqual(fixture.attempts, [a.id, b.id, b.id]);

  const decision = await fixture.nextDecision();
  assert.equal(decision.model, b.model);
  assert.equal(decision.mutations.cacheAwareSwitch?.action, "kept_sticky");
});

test("a successful fallback without reported usage does not inherit an unbound cache sample", async t => {
  const fixture = failoverFixture(t, { reportedUsage: false });
  await fixture.runInitialTurn();
  fixture.router.observeUsage(fixture.scope.sessionId, warmUsage);
  const decision = await fixture.nextDecision();
  assert.equal(decision.model, a.model);
  const comparison = decision.mutations.cacheAwareSwitch;
  assert.equal(comparison?.action, "switched");
  assert.equal(comparison?.from, b.id);
  assert.equal(comparison?.cachedCost, (comparison!.estimatedInputTokens / 1_000_000) * 10);
});

for (const lastAttempt of ["failure", "empty", "incomplete", "truncated"] as const) {
  test(`a later ${lastAttempt} attempt leaves the successful cache observation in place`, async t => {
    const fixture = failoverFixture(t, { lastAttempt });
    await fixture.runInitialTurn();
    const request = { ...fixture.request, provider: c.provider, model: c.model };
    const selected = await fixture.router.decide({
      ...fixture.scope,
      request,
      metadata: { explicitProvider: c.provider, explicitModel: c.model },
    });
    const turnRouting: RouterTurnRouting = { failedModels: new Set(), failedProviders: new Set() };
    await fixture.consume(fixture.router.execute(selected, request, { ...fixture.scope, turnId: "unsuccessful", turnRouting }));
    assert.deepEqual(fixture.attempts, [a.id, b.id, c.id]);
    if (lastAttempt === "truncated") {
      const continuation = await fixture.router.decide({ ...fixture.scope, request, turnRouting });
      assert.equal(continuation.model, c.model);
    }
    const decision = await fixture.nextDecision();
    assert.equal(decision.model, b.model);
    assert.equal(decision.mutations.cacheAwareSwitch?.action, "kept_sticky");
  });
}
