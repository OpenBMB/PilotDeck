import assert from "node:assert/strict";
import test from "node:test";

import {
  LITELLM_CONTINUATION_INSTRUCTION,
  createModelRuntime,
  parseModelConfig,
} from "../../src/model/index.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelTransport } from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import type { RouterEvent } from "../../src/router/protocol/events.js";

function request(): CanonicalModelRequest {
  return {
    provider: "openai",
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function routerConfig(): RouterConfig {
  return {
    enabled: false,
    scenarios: {
      default: { id: "openai/test-model", provider: "openai", model: "test-model" },
    },
  };
}

function modelRuntime(fetchImpl: ModelTransport) {
  const config = parseModelConfig({
    providers: {
      openai: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        retry: { streamMaxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        models: { "test-model": {} },
      },
    },
  });
  return createModelRuntime(config, { fetch: fetchImpl });
}

function fallbackModelRuntime(fetchImpl: ModelTransport) {
  const config = parseModelConfig({
    providers: {
      primary: {
        protocol: "openai",
        url: "https://primary.example.test/v1",
        apiKey: "test-key",
        retry: { streamMaxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        models: { primary: {} },
      },
      fallback: {
        protocol: "openai",
        url: "https://fallback.example.test/v1",
        apiKey: "test-key",
        retry: { streamMaxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        models: { fallback: {} },
      },
    },
  });
  return createModelRuntime(config, { fetch: fetchImpl });
}

function fallbackRouterConfig(transientMaxAttempts = 1): RouterConfig {
  return {
    enabled: true,
    scenarios: {
      default: { id: "primary/primary", provider: "primary", model: "primary" },
    },
    fallback: {
      default: [{ id: "fallback/fallback", provider: "fallback", model: "fallback" }],
      maxFallbacks: 5,
    },
    transientRetry: { enabled: true, maxAttempts: transientMaxAttempts, baseDelayMs: 1, maxDelayMs: 1 },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  };
}

function sseFrame(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function openAITextChunk(text: string): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function doneFrame(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

async function collect(stream: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

test("router stream recovers from pre-first-token network failure without continuation", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const fetchImpl: ModelTransport = async (_url, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) {
      throw new Error("fetch failed");
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame(openAITextChunk("ok")));
        controller.enqueue(doneFrame());
        controller.close();
      },
    }), { status: 200 });
  };

  const runtime = createRouterRuntime(routerConfig(), { modelRuntime: modelRuntime(fetchImpl) });
  const events = await collect(runtime.stream(request(), { sessionId: "s1", turnId: "t1", isMainAgent: true }));

  assert.equal(calls, 2);
  assert.equal(JSON.stringify(bodies[1]).includes(LITELLM_CONTINUATION_INSTRUCTION), false);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "ok"), true);
});

test("router stream recovers from post-content dropped stream with LiteLLM continuation", async () => {
  const bodies: unknown[] = [];
  const routerEvents: RouterEvent[] = [];
  let calls = 0;
  const fetchImpl: ModelTransport = async (_url, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    const chunks = calls === 1
      ? [sseFrame(openAITextChunk("partial before drop"))]
      : [sseFrame(openAITextChunk("continued")), doneFrame()];
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 });
  };

  const runtime = createRouterRuntime(routerConfig(), {
    modelRuntime: modelRuntime(fetchImpl),
    events: { emit: (event) => routerEvents.push(event) },
  });
  const events = await collect(runtime.stream(request(), { sessionId: "s2", turnId: "t2", isMainAgent: true }));

  assert.equal(calls, 2);
  assert.equal(JSON.stringify(bodies[1]).includes(LITELLM_CONTINUATION_INSTRUCTION), true);
  assert.equal(JSON.stringify(bodies[1]).includes("partial before drop"), true);
  assert.equal(routerEvents.some((event) => event.type === "pilotdeck_router_retry_progress" && event.reason === "continuation"), true);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "continued"), true);
});

test("router falls back on pre-content 429 without reporting an unslept Retry-After delay", async () => {
  const bodies: unknown[] = [];
  const routerEvents: RouterEvent[] = [];
  let calls = 0;
  const fetchImpl: ModelTransport = async (_url, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) {
      return Response.json({ error: { message: "rate limit" } }, { status: 429, headers: { "retry-after": "2" } });
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame(openAITextChunk("fallback ok")));
        controller.enqueue(doneFrame());
        controller.close();
      },
    }), { status: 200 });
  };

  const runtime = createRouterRuntime(fallbackRouterConfig(), {
    modelRuntime: fallbackModelRuntime(fetchImpl),
    events: { emit: (event) => routerEvents.push(event) },
  });
  const events = await collect(runtime.stream(request(), { sessionId: "s3", turnId: "t3", isMainAgent: true }));

  assert.equal(calls, 2);
  assert.equal(JSON.stringify(bodies[1]).includes(LITELLM_CONTINUATION_INSTRUCTION), false);
  assert.equal(routerEvents.some((event) => event.type === "pilotdeck_router_fallback"), true);
  assert.equal(routerEvents.some((event) => event.type === "pilotdeck_router_retry_progress" && event.delayMs === 2_000), false);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "fallback ok"), true);
});

test("router does not retry or fallback non-retryable 400", async () => {
  const routerEvents: RouterEvent[] = [];
  let calls = 0;
  const fetchImpl: ModelTransport = async () => {
    calls += 1;
    return Response.json({ error: { message: "bad request", type: "invalid_request" } }, { status: 400 });
  };

  const runtime = createRouterRuntime(fallbackRouterConfig(), {
    modelRuntime: fallbackModelRuntime(fetchImpl),
    events: { emit: (event) => routerEvents.push(event) },
  });
  const events = await collect(runtime.stream(request(), { sessionId: "s4", turnId: "t4", isMainAgent: true }));

  assert.equal(calls, 1);
  assert.equal(routerEvents.some((event) => event.type === "pilotdeck_router_fallback"), false);
  assert.equal(events.some((event) => event.type === "error" && event.error.retryable === false), true);
});

test("router mid-stream continuation starts after any visible generated content", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const fetchImpl: ModelTransport = async (_url, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sseFrame(openAITextChunk("tiny")));
          controller.enqueue(sseFrame({ error: { message: "overloaded", type: "overloaded_error" } }));
          controller.close();
        },
      }), { status: 200 });
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame(openAITextChunk("after tiny continuation")));
        controller.enqueue(doneFrame());
        controller.close();
      },
    }), { status: 200 });
  };

  const runtime = createRouterRuntime(fallbackRouterConfig(2), { modelRuntime: fallbackModelRuntime(fetchImpl) });
  const events = await collect(runtime.stream(request(), { sessionId: "s5", turnId: "t5", isMainAgent: true }));

  assert.equal(calls, 2);
  assert.equal(JSON.stringify(bodies[1]).includes(LITELLM_CONTINUATION_INSTRUCTION), true);
  assert.equal(JSON.stringify(bodies[1]).includes("tiny"), true);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "after tiny continuation"), true);
});
