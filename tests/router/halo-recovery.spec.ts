import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelEvent, CanonicalModelRequest, ModelCapabilities, ModelRuntime, ModelRuntimeOptions,
} from "../../src/model/index.js";
import { createModelRuntime, parseModelConfig } from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig, RouterModelRef } from "../../src/router/config/schema.js";
import type { RouterDecision } from "../../src/router/protocol/decision.js";
import type { RouterEvent } from "../../src/router/protocol/events.js";

const capabilities: ModelCapabilities = {
  supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false,
  supportsThinking: true, supportsJsonSchema: true, supportsSystemPrompt: true,
  supportsPromptCache: false, maxContextTokens: 100_000, maxOutputTokens: 4_096,
};
type Script = Record<string, Array<CanonicalModelEvent[]>>;

function fixture(
  script: Script,
  recovery: boolean,
  endpoints: Record<string, string>,
  options: {
    maxAttempts?: number;
    zeroUsageRetry?: RouterConfig["zeroUsageRetry"];
    capabilitiesByProvider?: Record<string, ModelCapabilities>;
    delayMsByProvider?: Record<string, number>;
    deadlineMs?: number;
    fallbackRefs?: RouterModelRef[];
    transientRetry?: RouterConfig["transientRetry"];
    now?: () => Date;
    delayMsForCall?: (provider: string, providerCall: number) => number;
  } = {},
) {
  const calls: string[] = [];
  const events: RouterEvent[] = [];
  const runtime: ModelRuntime = {
    async *stream(request: CanonicalModelRequest, _options?: ModelRuntimeOptions) {
      calls.push(request.provider);
      const providerCall = calls.filter((provider) => provider === request.provider).length;
      const delayMs = options.delayMsForCall?.(request.provider, providerCall)
        ?? options.delayMsByProvider?.[request.provider]
        ?? 0;
      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          const onAbort = () => {
            clearTimeout(timer);
            reject(_options?.signal?.reason ?? new DOMException("aborted", "AbortError"));
          };
          _options?.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      for (const event of script[request.provider]?.shift() ?? success(request.provider)) yield event;
    },
    async complete() { throw new Error("unused"); },
    getCapabilities: (provider) => options.capabilitiesByProvider?.[provider] ?? capabilities,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: (provider) => endpoints[provider],
  };
  const ref = (provider: string): RouterModelRef => ({ id: `${provider}/m`, provider, model: "m" });
  const config: RouterConfig = {
    enabled: true,
    scenarios: { default: ref("a") },
    fallback: { default: options.fallbackRefs ?? [ref("b"), ref("c")], maxFallbacks: 3 },
    zeroUsageRetry: options.zeroUsageRetry ?? { enabled: false, maxAttempts: 1 },
    transientRetry: options.transientRetry ?? { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    recovery: {
      enabled: recovery, maxAttempts: options.maxAttempts ?? 4, deadlineMs: options.deadlineMs ?? 1_000,
      health: { degradeThreshold: 1, openThreshold: 2, openDurationMs: 100, recordTtlMs: 1_000 },
    },
    stats: { enabled: false },
  };
  return {
    router: createRouterRuntime(config, {
      modelRuntime: runtime,
      events: { emit: (event) => events.push(event) },
      now: options.now,
    }),
    calls,
    events,
  };
}

const decision: RouterDecision = {
  provider: "a", model: "m", scenarioType: "default", isSubagent: false,
  orchestrating: false, resolvedFrom: "scenario", mutations: {},
};
const request: CanonicalModelRequest = {
  provider: "a", model: "m", stream: true,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};
const failure = (provider: string, code = "rate_limit_error", status = 429, retryAfterMs = 500): CanonicalModelEvent[] => [
  { type: "request_started", provider, model: "m" },
  { type: "error", error: { provider, protocol: "openai", code, status, message: code, retryable: true, retryAfterMs } },
];
const success = (provider: string): CanonicalModelEvent[] => [
  { type: "request_started", provider, model: "m" },
  { type: "message_start", role: "assistant" },
  { type: "text_delta", text: "ok" },
  { type: "message_end", finishReason: "stop" },
  { type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
];
const emptyResponse = (provider: string): CanonicalModelEvent[] => [
  { type: "request_started", provider, model: "m" },
  { type: "message_start", role: "assistant" },
  { type: "message_end", finishReason: "stop" },
  { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
];

async function collect(iterable: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const result: CanonicalModelEvent[] = [];
  for await (const event of iterable) result.push(event);
  return result;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the test condition.");
}

function sse(data: string): Response {
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
}

test("reproduces static duplicate-endpoint fallback and HALO selects an independent endpoint", async () => {
  const endpoints = { a: "https://shared.invalid/v1", b: "https://shared.invalid/v1", c: "https://healthy.invalid/v1" };
  const baseline = fixture({ a: [failure("a")], b: [failure("b")], c: [success("c")] }, false, endpoints);
  await collect(baseline.router.execute(decision, request, { sessionId: "base", turnId: "1" }));
  assert.deepEqual(baseline.calls, ["a", "b", "c"]);

  const halo = fixture({ a: [failure("a")], b: [failure("b")], c: [success("c")] }, true, endpoints);
  const output = await collect(halo.router.execute(decision, request, { sessionId: "halo", turnId: "1" }));
  assert.deepEqual(halo.calls, ["a", "c"]);
  assert.equal(output.some((event) => event.type === "text_delta" && event.text === "ok"), true);
  const traces = halo.events.filter((event) => event.type === "pilotdeck_router_attempt");
  assert.equal(traces.length, 4);
  await baseline.router.shutdown();
  await halo.router.shutdown();
});

test("partial text or tool-call output locks the attempt and prevents replay", async () => {
  for (const content of [
    { type: "text_delta", text: "partial" } as CanonicalModelEvent,
    { type: "tool_call_start", id: "call-1", name: "write" } as CanonicalModelEvent,
  ]) {
    const scripted = [
      { type: "request_started", provider: "a", model: "m" } as CanonicalModelEvent,
      content,
      ...failure("a", "server_error", 503).slice(1),
    ];
    const fx = fixture({ a: [scripted], b: [success("b")] }, true, { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" });
    await collect(fx.router.execute(decision, request, { sessionId: `locked-${content.type}`, turnId: "1" }));
    assert.deepEqual(fx.calls, ["a"]);
    await fx.router.shutdown();
  }
});

test("global dispatch budget covers zero-usage retries and fallback attempts", async () => {
  const fx = fixture(
    { a: [emptyResponse("a"), emptyResponse("a")], b: [success("b")] },
    true,
    { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" },
    { maxAttempts: 2, deadlineMs: 5_000, zeroUsageRetry: { enabled: true, maxAttempts: 5 } },
  );
  const output = await collect(fx.router.execute(decision, request, { sessionId: "budget", turnId: "1" }));
  assert.deepEqual(fx.calls, ["a", "a"]);
  const finalEvent = output.at(-1);
  assert.equal(finalEvent?.type, "error");
  if (finalEvent?.type === "error") assert.equal(finalEvent.error.code, "empty_response");
  await fx.router.shutdown();
});

test("filters tool-incompatible fallback candidates before dispatch", async () => {
  const noTools = { ...capabilities, supportsToolUse: false };
  const fx = fixture(
    { a: [failure("a")], b: [success("b")], c: [success("c")] },
    true,
    { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" },
    { capabilitiesByProvider: { b: noTools } },
  );
  await collect(fx.router.execute(decision, { ...request, tools: [{ name: "write", description: "write", inputSchema: { type: "object" } }] }, {
    sessionId: "tools", turnId: "1",
  }));
  assert.deepEqual(fx.calls, ["a", "c"]);
  await fx.router.shutdown();
});

test("thinking disabled does not exclude a model that lacks thinking capability", async () => {
  const noThinking = { ...capabilities, supportsThinking: false };
  const fx = fixture(
    { a: [failure("a")], b: [success("b")], c: [success("c")] },
    true,
    { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" },
    { capabilitiesByProvider: { b: noThinking } },
  );
  await collect(fx.router.execute(decision, { ...request, thinking: { enabled: false, mode: "off" } }, {
    sessionId: "thinking-off", turnId: "1",
  }));
  assert.deepEqual(fx.calls, ["a", "b"]);
  await fx.router.shutdown();
});

test("all candidates failing exits once with the final diagnostic", async () => {
  const fx = fixture(
    { a: [failure("a", "server_error", 503)], b: [failure("b", "server_error", 503)], c: [failure("c", "server_error", 503)] },
    true,
    { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" },
  );
  const output = await collect(fx.router.execute(decision, request, { sessionId: "all-fail", turnId: "1" }));
  assert.deepEqual(fx.calls, ["a", "b", "c"]);
  assert.equal(output.filter((event) => event.type === "error").length, 1);
  await fx.router.shutdown();
});

test("healthy requests add one trace pair and no extra provider dispatch", async () => {
  const fx = fixture({ a: [success("a")] }, true, { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" });
  await collect(fx.router.execute(decision, request, { sessionId: "healthy", turnId: "1" }));
  assert.deepEqual(fx.calls, ["a"]);
  assert.equal(fx.events.filter((event) => event.type === "pilotdeck_router_attempt").length, 2);
  await fx.router.shutdown();
});

test("the chain deadline aborts an in-flight dispatch instead of starting another candidate", async () => {
  const fx = fixture(
    { a: [success("a")], b: [success("b")] },
    true,
    { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" },
    { deadlineMs: 20, delayMsByProvider: { a: 200 } },
  );
  const started = Date.now();
  const output = await collect(fx.router.execute(decision, request, { sessionId: "deadline", turnId: "1" }));
  assert.ok(Date.now() - started < 150);
  assert.deepEqual(fx.calls, ["a"]);
  assert.equal(output.at(-1)?.type, "error");
  await fx.router.shutdown();
});

test("endpoint health is reused across sessions in the same router runtime", async () => {
  const fx = fixture(
    {
      a: [failure("a")],
      b: [failure("b"), failure("b")],
      c: [success("c"), success("c"), success("c")],
    },
    true,
    { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" },
  );
  const bDecision = { ...decision, provider: "b" };
  await collect(fx.router.execute(bDecision, request, { sessionId: "health-1", turnId: "1" }));
  await collect(fx.router.execute(bDecision, request, { sessionId: "health-2", turnId: "1" }));
  await collect(fx.router.execute(decision, request, { sessionId: "health-3", turnId: "1" }));
  assert.deepEqual(fx.calls, ["b", "c", "b", "c", "a", "c"]);
  await fx.router.shutdown();
});

test("the primary candidate shares the single half-open probe lease", async () => {
  let nowMs = 0;
  const fx = fixture(
    {
      a: [failure("a"), failure("a"), success("a")],
      b: [success("b"), success("b"), success("b")],
    },
    true,
    { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" },
    {
      now: () => new Date(nowMs),
      fallbackRefs: [{ id: "b/m", provider: "b", model: "m" }],
      delayMsForCall: (provider, providerCall) => provider === "a" && providerCall === 3 ? 30 : 0,
    },
  );
  await collect(fx.router.execute(decision, request, { sessionId: "open-1", turnId: "1" }));
  await collect(fx.router.execute(decision, request, { sessionId: "open-2", turnId: "1" }));
  nowMs = 500;

  const probe = collect(fx.router.execute(decision, request, { sessionId: "probe-1", turnId: "1" }));
  await waitFor(() => fx.calls.filter((provider) => provider === "a").length === 3);
  const concurrent = collect(fx.router.execute(decision, request, { sessionId: "probe-2", turnId: "1" }));
  await Promise.all([probe, concurrent]);

  assert.deepEqual(fx.calls, ["a", "b", "a", "b", "a", "b"]);
  await fx.router.shutdown();
});

test("cancelling a half-open primary probe releases its lease", async () => {
  let nowMs = 0;
  const fx = fixture(
    {
      a: [failure("a"), failure("a"), success("a")],
      b: [success("b"), success("b")],
    },
    true,
    { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" },
    {
      now: () => new Date(nowMs),
      fallbackRefs: [{ id: "b/m", provider: "b", model: "m" }],
      delayMsForCall: (provider, providerCall) => provider === "a" && providerCall === 3 ? 1_000 : 0,
    },
  );
  await collect(fx.router.execute(decision, request, { sessionId: "cancel-open-1", turnId: "1" }));
  await collect(fx.router.execute(decision, request, { sessionId: "cancel-open-2", turnId: "1" }));
  nowMs = 500;

  const controller = new AbortController();
  const cancelled = collect(fx.router.execute(decision, request, {
    sessionId: "cancel-probe", turnId: "1", abortSignal: controller.signal,
  }));
  await waitFor(() => fx.calls.filter((provider) => provider === "a").length === 3);
  controller.abort();
  await assert.rejects(cancelled, /abort/i);

  const output = await collect(fx.router.execute(decision, request, { sessionId: "probe-after-cancel", turnId: "1" }));
  assert.deepEqual(fx.calls, ["a", "b", "a", "b", "a", "a"]);
  assert.equal(output.some((event) => event.type === "text_delta" && event.text === "ok"), true);
  await fx.router.shutdown();
});

test("authentication failure never retries another model using the same provider credentials", async () => {
  const fx = fixture(
    { a: [failure("a", "auth_error", 401)], b: [success("b")], c: [success("c")] },
    true,
    { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" },
    { fallbackRefs: [{ id: "a/other", provider: "a", model: "other" }, { id: "b/m", provider: "b", model: "m" }] },
  );
  await collect(fx.router.execute(decision, request, { sessionId: "auth", turnId: "1" }));
  assert.deepEqual(fx.calls, ["a", "b"]);
  await fx.router.shutdown();
});

test("same-domain 429 honors full Retry-After when no independent fallback is available", async () => {
  const shared = { a: "https://shared.invalid", b: "https://shared.invalid", c: "https://shared.invalid" };
  const fx = fixture(
    { a: [failure("a", "rate_limit_error", 429, 30), success("a")] },
    true,
    shared,
    {
      deadlineMs: 500,
      maxAttempts: 2,
      transientRetry: { enabled: true, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    },
  );
  const started = Date.now();
  const output = await collect(fx.router.execute(decision, request, { sessionId: "retry-after", turnId: "1" }));
  const elapsed = Date.now() - started;
  assert.deepEqual(fx.calls, ["a", "a"]);
  assert.ok(elapsed >= 20, `expected Retry-After wait, got ${elapsed}ms`);
  assert.equal(output.some((event) => event.type === "text_delta" && event.text === "ok"), true);
  const retryEvent = fx.events.find((event) => event.type === "pilotdeck_router_transient_retry");
  assert.equal(retryEvent?.type === "pilotdeck_router_transient_retry" ? retryEvent.delayMs : undefined, 30);
  await fx.router.shutdown();
});

test("HALO preserves safe text continuation inside the chain-wide dispatch budget", async () => {
  let requests = 0;
  const events: RouterEvent[] = [];
  const modelRuntime = createModelRuntime(parseModelConfig({
    providers: {
      a: {
        protocol: "openai",
        url: "https://a.invalid/v1",
        apiKey: "test-key",
        retry: { streamMaxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        models: { m: {} },
      },
    },
  }), {
    fetch: async () => {
      requests++;
      return requests === 1
        ? sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        : sse('data: {"choices":[{"delta":{"content":" done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  });
  const model = { id: "a/m", provider: "a", model: "m" };
  const router = createRouterRuntime({
    enabled: true,
    scenarios: { default: model },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    recovery: { enabled: true, maxAttempts: 2, deadlineMs: 1_000 },
    stats: { enabled: false },
  }, { modelRuntime, events: { emit: (event) => events.push(event) } });

  const output = await collect(router.execute(decision, request, { sessionId: "continuation", turnId: "1" }));
  assert.equal(requests, 2);
  assert.equal(output.filter((event) => event.type === "error").length, 0);
  assert.equal(output.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), "partial done");
  assert.equal(events.some((event) => event.type === "pilotdeck_router_retry_progress" && event.reason === "continuation"), true);
  const attempts = events.filter((event) => event.type === "pilotdeck_router_attempt");
  assert.deepEqual(attempts.map((event) => [event.phase, event.attempt]), [
    ["start", 1], ["end", 1], ["start", 2], ["end", 2],
  ]);
  assert.equal(attempts[1]?.phase === "end" ? attempts[1].errorCode : undefined, "stream_interrupted");
  await router.shutdown();
});

test("HALO rejects text continuation when the chain-wide dispatch budget is exhausted", async () => {
  let requests = 0;
  const events: RouterEvent[] = [];
  const modelRuntime = createModelRuntime(parseModelConfig({
    providers: {
      a: {
        protocol: "openai",
        url: "https://a.invalid/v1",
        apiKey: "test-key",
        retry: { streamMaxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        models: { m: {} },
      },
    },
  }), {
    fetch: async () => {
      requests++;
      return sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    },
  });
  const model = { id: "a/m", provider: "a", model: "m" };
  const router = createRouterRuntime({
    enabled: true,
    scenarios: { default: model },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    recovery: { enabled: true, maxAttempts: 1, deadlineMs: 1_000 },
    stats: { enabled: false },
  }, { modelRuntime, events: { emit: (event) => events.push(event) } });

  const output = await collect(router.execute(decision, request, { sessionId: "continuation-budget", turnId: "1" }));
  assert.equal(requests, 1);
  assert.equal(output.some((event) => event.type === "error" && event.error.streamInterruption?.phase === "text"), true);
  assert.equal(events.filter((event) => event.type === "pilotdeck_router_attempt").length, 2);
  await router.shutdown();
});

test("an already-aborted request propagates cancellation without recording a provider failure", async () => {
  const fx = fixture({ a: [success("a")] }, true, { a: "https://a.invalid", b: "https://b.invalid", c: "https://c.invalid" });
  const controller = new AbortController();
  controller.abort("user stopped");
  await assert.rejects(() => collect(fx.router.execute(decision, request, {
    sessionId: "cancel", turnId: "1", abortSignal: controller.signal,
  })), /user stopped/);
  assert.deepEqual(fx.calls, []);
  await fx.router.shutdown();
});
