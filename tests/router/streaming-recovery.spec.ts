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

test("stream recovery retries a pre-token network failure without continuation context", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const transport: ModelTransport = async (_url, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) throw new Error("fetch failed");
    return sseResponse([textChunk("ok"), doneChunk()]);
  };

  const events = await collect(router(transport).stream(request(), context("s1", "t1")));

  assert.equal(calls, 2);
  assert.equal(JSON.stringify(bodies[1]).includes(LITELLM_CONTINUATION_INSTRUCTION), false);
  assert.equal(events.some(event => event.type === "text_delta" && event.text === "ok"), true);
});

test("stream recovery continues after visible content from a dropped stream", async () => {
  const bodies: unknown[] = [];
  const routerEvents: RouterEvent[] = [];
  let calls = 0;
  const transport: ModelTransport = async (_url, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    return calls === 1
      ? sseResponse([textChunk("partial before drop")])
      : sseResponse([textChunk("continued"), doneChunk()]);
  };

  const events = await collect(router(transport, routerEvents).stream(request(), context("s2", "t2")));

  assert.equal(calls, 2);
  assert.match(JSON.stringify(bodies[1]), new RegExp(LITELLM_CONTINUATION_INSTRUCTION));
  assert.match(JSON.stringify(bodies[1]), /partial before drop/);
  assert.equal(routerEvents.some(event =>
    event.type === "pilotdeck_router_retry_progress" && event.reason === "continuation"), true);
  assert.equal(events.some(event => event.type === "text_delta" && event.text === "continued"), true);
});

test("stream recovery falls back on 429 without reporting an unslept Retry-After", async () => {
  const routerEvents: RouterEvent[] = [];
  let calls = 0;
  const transport: ModelTransport = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { error: { message: "rate limit" } },
        { status: 429, headers: { "retry-after": "2" } },
      );
    }
    return sseResponse([textChunk("fallback ok"), doneChunk()]);
  };

  const runtime = createRouterRuntime(fallbackConfig(), {
    modelRuntime: fallbackModel(transport),
    events: { emit: event => routerEvents.push(event) },
  });
  const events = await collect(runtime.stream(request(), context("s3", "t3")));

  assert.equal(calls, 2);
  assert.equal(routerEvents.some(event => event.type === "pilotdeck_router_fallback"), true);
  assert.equal(routerEvents.some(event =>
    event.type === "pilotdeck_router_retry_progress" && event.delayMs === 2_000), false);
  assert.equal(events.some(event => event.type === "text_delta" && event.text === "fallback ok"), true);
});

test("stream recovery does not retry or fall back after a non-retryable 400", async () => {
  const routerEvents: RouterEvent[] = [];
  let calls = 0;
  const transport: ModelTransport = async () => {
    calls += 1;
    return Response.json({ error: { message: "bad request", type: "invalid_request" } }, { status: 400 });
  };
  const runtime = createRouterRuntime(fallbackConfig(), {
    modelRuntime: fallbackModel(transport),
    events: { emit: event => routerEvents.push(event) },
  });

  const events = await collect(runtime.stream(request(), context("s4", "t4")));

  assert.equal(calls, 1);
  assert.equal(routerEvents.some(event => event.type === "pilotdeck_router_fallback"), false);
  assert.equal(events.some(event => event.type === "error" && event.error.retryable === false), true);
});

test("stream recovery continues after any amount of visible content", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const transport: ModelTransport = async (_url, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    return calls === 1
      ? sseResponse([
          textChunk("tiny"),
          jsonChunk({ error: { message: "overloaded", type: "overloaded_error" } }),
        ])
      : sseResponse([textChunk("after continuation"), doneChunk()]);
  };
  const runtime = createRouterRuntime(fallbackConfig(2), { modelRuntime: fallbackModel(transport) });

  const events = await collect(runtime.stream(request(), context("s5", "t5")));

  assert.equal(calls, 2);
  assert.match(JSON.stringify(bodies[1]), new RegExp(LITELLM_CONTINUATION_INSTRUCTION));
  assert.match(JSON.stringify(bodies[1]), /tiny/);
  assert.equal(events.some(event => event.type === "text_delta" && event.text === "after continuation"), true);
});

function router(transport: ModelTransport, events: RouterEvent[] = []) {
  return createRouterRuntime(disabledRouterConfig(), {
    modelRuntime: model(transport),
    events: { emit: event => events.push(event) },
  });
}

function model(transport: ModelTransport) {
  return createModelRuntime(parseModelConfig({
    providers: {
      openai: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        retry: { streamMaxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        models: { "test-model": {} },
      },
    },
  }), { fetch: transport });
}

function fallbackModel(transport: ModelTransport) {
  return createModelRuntime(parseModelConfig({
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
  }), { fetch: transport });
}

function disabledRouterConfig(): RouterConfig {
  return {
    enabled: false,
    scenarios: { default: { id: "openai/test-model", provider: "openai", model: "test-model" } },
  };
}

function fallbackConfig(transientMaxAttempts = 1): RouterConfig {
  return {
    enabled: true,
    scenarios: { default: { id: "primary/primary", provider: "primary", model: "primary" } },
    fallback: {
      default: [{ id: "fallback/fallback", provider: "fallback", model: "fallback" }],
      maxFallbacks: 5,
    },
    transientRetry: {
      enabled: true,
      maxAttempts: transientMaxAttempts,
      baseDelayMs: 1,
      maxDelayMs: 1,
    },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  };
}

function request(): CanonicalModelRequest {
  return {
    provider: "openai",
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function context(sessionId: string, turnId: string) {
  return { sessionId, turnId, isMainAgent: true };
}

function sseResponse(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200 });
}

function textChunk(text: string): Uint8Array {
  return jsonChunk({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
}

function jsonChunk(value: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

function doneChunk(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

async function collect(stream: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
