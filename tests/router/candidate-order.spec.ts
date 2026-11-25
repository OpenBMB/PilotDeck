import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { CanonicalModelError, CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import type { RouterTurnRouting } from "../../src/router/protocol/decision.js";
import type { RouterModelPricingMap } from "../../src/router/utils/modelPricing.js";

const SIMPLE = "shared/first";
const MEDIUM = "shared/second";
const COMPLEX = "z-tier/third";
const REASONING = "z-tier/fourth";
const POOL = "a-pool/cheap";

function ref(id: string) {
  const [provider, model] = id.split("/");
  return { id, provider, model };
}

const tiers = {
  reasoning: { model: ref(REASONING) },
  simple: { model: ref(SIMPLE) },
  complex: { model: ref(COMPLEX) },
  medium: { model: ref(MEDIUM) },
};

function fixture(t: TestContext, options: {
  tier?: string;
  tierModels?: NonNullable<RouterConfig["tokenSaver"]>["tiers"];
  pool?: string[];
  textOnly?: string[];
  withoutTools?: string[];
  withoutStreaming?: string[];
  transientRetries?: number;
  errors?: Record<string, CanonicalModelError | Error>;
  prices?: RouterModelPricingMap;
} = {}) {
  const sent: string[] = [];
  const tier = options.tier ?? "simple";
  const modelRuntime: ModelRuntime = {
    async *stream(request): AsyncIterable<CanonicalModelEvent> {
      const id = `${request.provider}/${request.model}`;
      sent.push(id);
      const error = options.errors?.[id];
      if (error instanceof Error) throw error;
      if (error) {
        yield { type: "error", error };
        return;
      }
      yield { type: "text_delta", text: "Synthetic answer" };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return { role: "assistant", content: [{ type: "text", text: `<tier>${tier}</tier>` }], finishReason: "stop" };
    },
    getCapabilities(provider, model) {
      return {
        supportsToolUse: !options.withoutTools?.includes(`${provider}/${model}`),
        supportsStreaming: !options.withoutStreaming?.includes(`${provider}/${model}`),
        supportsParallelToolCalls: true, supportsSystemPrompt: true,
        supportsThinking: false, supportsJsonSchema: false, supportsPromptCache: false,
        maxContextTokens: 100000, maxOutputTokens: 1024,
      };
    },
    getMultimodal(provider, model) {
      return { input: options.textOnly?.includes(`${provider}/${model}`) ? ["text"] : ["text", "image"] };
    },
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.test",
  };
  const router = createRouterRuntime({
    scenarios: { default: ref(SIMPLE) },
    tokenSaver: { enabled: true, tiers: options.tierModels ?? tiers, defaultTier: tier, judge: ref("judge/classifier"), judgeTimeoutMs: 1000 },
    autoOrchestrate: { enabled: true, triggerTiers: ["medium"], slimSystemPrompt: false },
    stats: { enabled: false, modelPricing: options.prices },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: options.transientRetries !== undefined, maxAttempts: options.transientRetries ?? 1,
      baseDelayMs: 0, maxDelayMs: 0 },
  }, {
    modelRuntime,
    modelPool: (options.pool ?? [SIMPLE, MEDIUM, COMPLEX, REASONING, POOL]).map(ref),
  });
  t.after(() => router.shutdown());
  const request: CanonicalModelRequest = {
    provider: "shared", model: "first",
    messages: [{ role: "user", content: [{ type: "text", text: "Synthetic task" }] }],
  };
  const ctx = { sessionId: "test-session", turnId: "test-turn", isMainAgent: true };
  return { router, request, ctx, sent };
}

function modelError(code: string, status?: number): CanonicalModelError {
  return { provider: "shared", protocol: "openai", code, status, message: "Synthetic failure", retryable: false };
}

test("streaming failover skips a non-streaming pool model", async t => {
  const next = "a-pool/streaming";
  const { router, request, ctx, sent } = fixture(t, {
    tierModels: { simple: tiers.simple }, pool: [SIMPLE, POOL, next],
    withoutStreaming: [POOL], errors: { [SIMPLE]: { ...modelError("rate_limit_error", 429), retryable: true } },
  });
  const events = await collect(router.stream({ ...request, stream: true }, ctx));
  assert.deepEqual(sent, [SIMPLE, next]);
  assert.ok(events.some(event => event.type === "message_end"));
  assert.ok(events.every(event => event.type !== "error"));
});

test("a new turn can probe the only provider after retries opened its circuit", async t => {
  const errors: Record<string, CanonicalModelError> = { [SIMPLE]: modelError("connection_refused") };
  const { router, request, ctx, sent } = fixture(t, {
    tierModels: { simple: tiers.simple }, pool: [SIMPLE], transientRetries: 4, errors,
  });
  const failed = await collect(router.stream(request, ctx));
  assert.equal(sent.length, 5);
  assert.ok(failed.some(event => event.type === "error" && event.error.code === "connection_refused"));

  delete errors[SIMPLE];
  router.invalidateSticky(ctx.sessionId);
  const recovered = await collect(router.stream(request, { ...ctx, turnId: "recovered" }));
  assert.equal(sent.length, 6);
  assert.ok(recovered.some(event => event.type === "message_end"));
  assert.ok(recovered.every(event => event.type !== "error"));
});

async function collect(events: AsyncIterable<CanonicalModelEvent>) {
  const result: CanonicalModelEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

for (const requirement of ["image", "tool"] as const) {
  test(`routes ${requirement} requests to the next eligible tier ahead of a cheaper pool model`, async t => {
    const { router, request, ctx, sent } = fixture(t, {
      textOnly: requirement === "image" ? [SIMPLE] : [],
      withoutTools: requirement === "tool" ? [SIMPLE] : [],
      prices: { [POOL]: { input: 0, output: 0 } },
    });
    if (requirement === "image") {
      request.messages[0].content.push({ type: "image", source: "base64", mimeType: "image/png", bytes: 1, data: "AA==" });
    } else {
      request.tools = [{ name: "read_file", inputSchema: { type: "object" } }];
    }

    const decision = await router.decide({ ...ctx, request });
    const events = await collect(router.execute(decision, request, ctx));
    assert.deepEqual(sent, [MEDIUM]);
    assert.equal(decision.tokenSaverTier, "simple");
    assert.equal(decision.orchestrating, false);
    assert.ok(events.some(event => event.type === "text_delta"));
  });
}

for (const error of [modelError("model_not_found", 404), modelError("auth_error", 403)]) {
  test(`keeps same-provider tier alternatives eligible after a model-scoped ${error.status}`, async t => {
    const { router, request, ctx, sent } = fixture(t, { errors: { [SIMPLE]: error } });
    const turnRouting: RouterTurnRouting = { failedModels: new Set(), failedProviders: new Set() };
    const events = await collect(router.stream(request, { ...ctx, turnRouting }));
    assert.deepEqual(sent, [SIMPLE, MEDIUM]);
    assert.deepEqual([...turnRouting.failedModels], [SIMPLE]);
    assert.equal(turnRouting.failedProviders.size, 0);
    assert.ok(events.some(event => event.type === "text_delta"));

    await collect(router.stream(request, { ...ctx, turnRouting }));
    assert.deepEqual(sent, [SIMPLE, MEDIUM, MEDIUM]);
  });
}

test("a refused endpoint skips sibling models and continues to the next tier before the pool", async t => {
  const refused = Object.assign(new Error("Synthetic socket refusal"), { code: "ECONNREFUSED" });
  const failure = new TypeError("fetch failed", { cause: refused });
  const { router, request, ctx, sent } = fixture(t, { errors: { [SIMPLE]: failure } });
  const turnRouting: RouterTurnRouting = { failedModels: new Set(), failedProviders: new Set() };
  await collect(router.stream(request, { ...ctx, turnRouting }));
  assert.deepEqual(sent, [SIMPLE, COMPLEX]);
  assert.deepEqual([...turnRouting.failedProviders], ["shared"]);

  await collect(router.stream(request, { ...ctx, turnRouting }));
  assert.deepEqual(sent, [SIMPLE, COMPLEX, COMPLEX]);
});

test("a high tier excludes lower-only tiers from the pool and ranks comparable configured input and output prices", async t => {
  const expensive = "a-pool/expensive-output";
  const incomplete = "b-pool/incomplete-price";
  const cheap = "x-pool/cheap-output";
  const duplicate = ref(REASONING);
  const { router, request, ctx, sent } = fixture(t, {
    tier: "complex",
    tierModels: { ...tiers, complex: { model: duplicate } },
    pool: [SIMPLE, MEDIUM, REASONING, expensive, incomplete, cheap],
    errors: { [REASONING]: modelError("model_not_found", 404) },
    prices: {
      [SIMPLE]: { input: 0, output: 0 },
      [MEDIUM]: { input: 0, output: 0 },
      [expensive]: { input: 1, output: 10 },
      [incomplete]: { input: 0 },
      [cheap]: { input: 1, output: 2 },
    },
  });
  await collect(router.stream(request, ctx));
  assert.deepEqual(sent, [REASONING, cheap]);
});

test("pool pricing compares candidates within currencies and puts missing prices after complete ones", async t => {
  const noPrice = "a-pool/unknown";
  const usdExpensive = "b-pool/usd";
  const cny = "c-pool/cny";
  const usdCheap = "d-pool/usd";
  const fail = { ...modelError("model_not_found", 404), provider: "a-pool" };
  const { router, request, ctx, sent } = fixture(t, {
    tier: "reasoning",
    pool: [REASONING, noPrice, usdExpensive, cny, usdCheap],
    errors: { [REASONING]: fail, [usdCheap]: fail, [cny]: fail, [usdExpensive]: fail },
    prices: {
      [usdExpensive]: { input: 100, output: 100 },
      [cny]: { input: 0, output: 0, unit: "¥/百万 Token" },
      [usdCheap]: { input: 10, output: 10 },
    },
  });
  await collect(router.stream(request, ctx));
  assert.deepEqual(sent, [REASONING, usdCheap, cny, usdExpensive, noPrice]);
});
