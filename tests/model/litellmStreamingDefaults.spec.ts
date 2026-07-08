import assert from "node:assert/strict";
import test from "node:test";

import {
  LITELLM_CONTINUATION_INSTRUCTION,
  LITELLM_COMPLETION_HTTP_FALLBACK_MS,
  LITELLM_DEFAULT_MAX_RETRIES,
  LITELLM_DEFAULT_REQUEST_TIMEOUT_MS,
  LITELLM_HTTP_CONNECTOR_LIMIT,
  LITELLM_HTTP_CONNECTOR_LIMIT_PER_HOST,
  LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS,
  LITELLM_HTTP_SO_KEEPALIVE,
  LITELLM_HTTP_TCP_KEEPCNT,
  LITELLM_HTTP_TCP_KEEPIDLE_SECONDS,
  LITELLM_HTTP_TCP_KEEPINTVL_SECONDS,
  LITELLM_HTTP_TTL_DNS_CACHE_MS,
  LITELLM_INITIAL_RETRY_DELAY_MS,
  LITELLM_MAX_RETRY_DELAY_MS,
  LITELLM_REPEATED_STREAMING_CHUNK_LIMIT,
  LITELLM_RETRY_JITTER,
  LITELLM_STREAM_MAX_DURATION_MS,
  buildLiteLLMContinuationRequest,
  parseModelConfig,
  streamModel,
} from "../../src/model/index.js";
import type { CanonicalModelRequest, ModelConfig, ModelProtocol } from "../../src/model/index.js";

const request: CanonicalModelRequest = {
  provider: "openai",
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

function modelConfig(retry?: Record<string, unknown>): ModelConfig {
  return parseModelConfig({
    providers: {
      openai: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        ...(retry ? { retry } : {}),
        models: { "test-model": {} },
      },
    },
  });
}

function protocolModelConfig(protocol: ModelProtocol, retry?: Record<string, unknown>): ModelConfig {
  return parseModelConfig({
    providers: {
      provider: {
        protocol,
        url: "https://example.test/v1",
        apiKey: "test-key",
        ...(retry ? { retry } : {}),
        models: { "test-model": {} },
      },
    },
  });
}

function protocolRequest(protocol: ModelProtocol): CanonicalModelRequest {
  return {
    ...request,
    provider: "provider",
    model: "test-model",
    ...(protocol === "openai-responses" ? { maxOutputTokens: 64 } : {}),
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

function openAIResponsesEvent(type: string, extra: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
}

function anthropicEvent(type: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

test("LiteLLM-compatible streaming defaults are exposed", () => {
  assert.equal(LITELLM_DEFAULT_MAX_RETRIES, 2);
  assert.equal(LITELLM_DEFAULT_REQUEST_TIMEOUT_MS, 6_000_000);
  assert.equal(LITELLM_COMPLETION_HTTP_FALLBACK_MS, 600_000);
  assert.equal(LITELLM_REPEATED_STREAMING_CHUNK_LIMIT, 100);
  assert.equal(LITELLM_INITIAL_RETRY_DELAY_MS, 500);
  assert.equal(LITELLM_MAX_RETRY_DELAY_MS, 8_000);
  assert.equal(LITELLM_RETRY_JITTER, 0.75);
  assert.equal(LITELLM_STREAM_MAX_DURATION_MS, undefined);
  assert.equal(LITELLM_HTTP_CONNECTOR_LIMIT, 1000);
  assert.equal(LITELLM_HTTP_CONNECTOR_LIMIT_PER_HOST, 500);
  assert.equal(LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS, 120_000);
  assert.equal(LITELLM_HTTP_TTL_DNS_CACHE_MS, 300_000);
  assert.equal(LITELLM_HTTP_SO_KEEPALIVE, false);
  assert.equal(LITELLM_HTTP_TCP_KEEPIDLE_SECONDS, 60);
  assert.equal(LITELLM_HTTP_TCP_KEEPINTVL_SECONDS, 30);
  assert.equal(LITELLM_HTTP_TCP_KEEPCNT, 5);
});

test("parseModelConfig accepts LiteLLM-compatible retry fields", () => {
  const config = modelConfig({
    maxStreamingDurationMs: 1234,
    repeatedChunkLimit: 99,
    baseDelayMs: 500,
    maxDelayMs: 8000,
    jitter: 0.75,
  });
  assert.deepEqual(config.providers.openai.retry, {
    maxStreamingDurationMs: 1234,
    repeatedChunkLimit: 99,
    baseDelayMs: 500,
    maxDelayMs: 8000,
    jitter: 0.75,
  });
});

test("streamModel retries after repeated chunks reach configured LiteLLM guard", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const chunks = calls === 1
      ? [sseFrame(openAITextChunk("repeat")), sseFrame(openAITextChunk("repeat"))]
      : [sseFrame(openAITextChunk("ok")), new TextEncoder().encode("data: [DONE]\n\n")];
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 });
  };

  const events = [];
  for await (const event of streamModel(request, modelConfig({ repeatedChunkLimit: 2, streamMaxRetries: 1 }), { fetch: fetchImpl })) {
    events.push(event);
  }

  assert.equal(calls, 2);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "ok"), true);
});

test("streamModel max streaming duration is disabled by default and enforced when configured", async () => {
  const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseFrame(openAITextChunk("ok")));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200 });

  const defaultEvents = [];
  for await (const event of streamModel(request, modelConfig(), { fetch: fetchImpl })) {
    defaultEvents.push(event);
  }
  assert.equal(defaultEvents.some((event) => event.type === "text_delta"), true);

  const slowFetch = async () => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.enqueue(sseFrame(openAITextChunk("late")));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200 });

  await assert.rejects(async () => {
    for await (const _event of streamModel(request, modelConfig({ maxStreamingDurationMs: 1, streamMaxRetries: 0 }), { fetch: slowFetch })) {
      // consume
    }
  }, /max streaming duration|exceeded/i);
});

test("request streamTimeoutMs overrides provider stream idle timeout", async () => {
  const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.enqueue(sseFrame(openAITextChunk("late")));
      controller.close();
    },
  }), { status: 200 });

  await assert.rejects(async () => {
    for await (const _event of streamModel(
      request,
      modelConfig({ streamIdleTimeoutMs: 60_000, streamMaxRetries: 0 }),
      { fetch: fetchImpl, streamTimeoutMs: 1 },
    )) {
      // consume
    }
  }, /Stream idle timeout/);
});

test("LiteLLM continuation request includes partial content and no-repeat instruction", () => {
  const continuation = buildLiteLLMContinuationRequest(request, "partial answer");
  assert.equal(continuation.messages.length, request.messages.length + 2);
  assert.deepEqual(continuation.messages.at(-2), {
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
  });
  assert.deepEqual(continuation.messages.at(-1), {
    role: "user",
    content: [{ type: "text", text: LITELLM_CONTINUATION_INSTRUCTION }],
  });
  assert.equal(JSON.stringify(continuation).includes("Continue from where you left off."), false);
});

test("LiteLLM continuation builder strips prior continuation pair before appending", () => {
  const first = buildLiteLLMContinuationRequest(request, "first partial");
  const second = buildLiteLLMContinuationRequest(first, "second partial");
  assert.equal(second.messages.length, request.messages.length + 2);
  assert.equal(JSON.stringify(second).includes("first partial"), false);
  assert.equal(JSON.stringify(second).includes("second partial"), true);
  assert.equal(JSON.stringify(second).match(new RegExp(LITELLM_CONTINUATION_INSTRUCTION, "g"))?.length, 1);
});

test("pre-first-content retry keeps original request messages", async () => {
  const requestBodies: unknown[] = [];
  let calls = 0;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    requestBodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) {
      throw new Error("fetch failed");
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame(openAITextChunk("ok")));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200 });
  };

  for await (const _event of streamModel(request, modelConfig({ streamMaxRetries: 1 }), { fetch: fetchImpl })) {
    // consume
  }

  assert.equal(calls, 2);
  assert.equal(JSON.stringify(requestBodies[1]).includes(LITELLM_CONTINUATION_INSTRUCTION), false);
  assert.equal(JSON.stringify(requestBodies[1]).includes("Continue from where you left off."), false);
});

test("post-content retry sends LiteLLM continuation request", async () => {
  const requestBodies: unknown[] = [];
  let calls = 0;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    requestBodies.push(JSON.parse(String(init?.body)));
    const partialChunks = Array.from(
      { length: 60 },
      (_, index) => sseFrame(openAITextChunk(`partial content ${index} that is long enough for continuation retry `)),
    );
    const chunks = calls === 1
      ? partialChunks
      : [sseFrame(openAITextChunk("continued")), new TextEncoder().encode("data: [DONE]\n\n")];
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 });
  };

  for await (const _event of streamModel(request, modelConfig({ streamMaxRetries: 1 }), { fetch: fetchImpl })) {
    // consume
  }

  assert.equal(calls, 2);
  const retriedBody = JSON.stringify(requestBodies[1]);
  assert.equal(retriedBody.includes(LITELLM_CONTINUATION_INSTRUCTION), true);
  assert.equal(retriedBody.includes("partial content 0 that is long enough"), true);
  assert.equal(retriedBody.includes("Continue from where you left off."), false);
});

test("stream retry cancels the failed SSE reader before retrying", async () => {
  let calls = 0;
  let cancelCount = 0;
  const fetchImpl = async () => {
    calls += 1;
    const chunks = calls === 1
      ? [sseFrame(openAITextChunk("repeat")), sseFrame(openAITextChunk("repeat"))]
      : [sseFrame(openAITextChunk("ok")), new TextEncoder().encode("data: [DONE]\n\n")];
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (calls !== 1) {
          controller.close();
        }
      },
      cancel() {
        cancelCount += 1;
      },
    }), { status: 200 });
  };

  for await (const _event of streamModel(request, modelConfig({ repeatedChunkLimit: 2, streamMaxRetries: 1 }), { fetch: fetchImpl })) {
    // consume
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.equal(cancelCount >= 1, true);
});

test("model stream retry progress reports continuation", async () => {
  const progressReasons: string[] = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const chunks = calls === 1
      ? [sseFrame(openAITextChunk("partial content for continuation"))]
      : [sseFrame(openAITextChunk("continued")), new TextEncoder().encode("data: [DONE]\n\n")];
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 });
  };

  for await (const _event of streamModel(
    request,
    modelConfig({ streamMaxRetries: 1 }),
    { fetch: fetchImpl, onRetryProgress: (progress) => progressReasons.push(progress.reason) },
  )) {
    // consume
  }

  assert.deepEqual(progressReasons, ["continuation"]);
});

test("non-retryable 4xx surfaces without retry while 429 retries with Retry-After", async () => {
  let badRequestCalls = 0;
  const badRequestFetch = async () => {
    badRequestCalls += 1;
    return Response.json({ error: { message: "bad request", type: "invalid_request" } }, { status: 400 });
  };

  const badRequestEvents = [];
  for await (const event of streamModel(request, modelConfig({ streamMaxRetries: 1 }), { fetch: badRequestFetch })) {
    badRequestEvents.push(event);
  }

  assert.equal(badRequestCalls, 1);
  const badRequestError = badRequestEvents.find((event) => event.type === "error")?.error;
  assert.equal(badRequestError?.retryable, false);

  let rateLimitCalls = 0;
  const progressDelays: number[] = [];
  const rateLimitFetch = async () => {
    rateLimitCalls += 1;
    if (rateLimitCalls === 1) {
      return Response.json(
        { error: { message: "rate limit" } },
        { status: 429, headers: { "retry-after": "3" } },
      );
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame(openAITextChunk("ok after 429")));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200 });
  };
  const rateLimitEvents = [];
  for await (const event of streamModel(
    request,
    modelConfig({ streamMaxRetries: 1, baseDelayMs: 1, maxDelayMs: 5_000, jitter: 0 }),
    { fetch: rateLimitFetch, onRetryProgress: (progress) => progressDelays.push(progress.delayMs) },
  )) {
    rateLimitEvents.push(event);
  }
  assert.equal(rateLimitCalls, 2);
  assert.deepEqual(progressDelays, [3_000]);
  assert.equal(rateLimitEvents.some((event) => event.type === "text_delta" && event.text === "ok after 429"), true);
});

test("streamTimeoutMs bounds the pre-response fetch phase", async () => {
  let abortObserved = false;
  const hangingFetch = async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      abortObserved = true;
      reject(new Error("request timeout"));
    }, { once: true });
  });

  await assert.rejects(async () => {
    for await (const _event of streamModel(
      request,
      modelConfig({ streamMaxRetries: 0 }),
      { fetch: hangingFetch, streamTimeoutMs: 1 },
    )) {
      // consume
    }
  }, /request timeout|timeout/i);
  assert.equal(abortObserved, true);
});

test("OpenAI Responses and Anthropic stream drops recover with LiteLLM continuation", async () => {
  const cases: Array<{ protocol: ModelProtocol; first: Uint8Array[]; second: Uint8Array[]; expectedText: string }> = [
    {
      protocol: "openai-responses",
      first: [openAIResponsesEvent("response.created", { response: { id: "resp_test" } }), openAIResponsesEvent("response.output_text.delta", { delta: "partial response" })],
      second: [openAIResponsesEvent("response.created", { response: { id: "resp_test_2" } }), openAIResponsesEvent("response.output_text.delta", { delta: "continued response" }), openAIResponsesEvent("response.completed", { response: { id: "resp_test_2", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })],
      expectedText: "continued response",
    },
    {
      protocol: "anthropic",
      first: [
        anthropicEvent("message_start", { message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "test-model" } }),
        anthropicEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        anthropicEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial response" } }),
      ],
      second: [
        anthropicEvent("message_start", { message: { id: "msg_2", type: "message", role: "assistant", content: [], model: "test-model" } }),
        anthropicEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        anthropicEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: "continued response" } }),
        anthropicEvent("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
        anthropicEvent("message_stop", {}),
      ],
      expectedText: "continued response",
    },
  ];

  for (const testCase of cases) {
    const requestBodies: unknown[] = [];
    let calls = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body)));
      const chunks = calls === 1 ? testCase.first : testCase.second;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }), { status: 200 });
    };

    const events = [];
    for await (const event of streamModel(
      protocolRequest(testCase.protocol),
      protocolModelConfig(testCase.protocol, { streamMaxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 }),
      { fetch: fetchImpl },
    )) {
      events.push(event);
    }

    assert.equal(calls, 2, `${testCase.protocol} should retry once`);
    assert.equal(JSON.stringify(requestBodies[1]).includes(LITELLM_CONTINUATION_INSTRUCTION), true);
    assert.equal(JSON.stringify(requestBodies[1]).includes("partial response"), true);
    assert.equal(events.some((event) => event.type === "text_delta" && event.text === testCase.expectedText), true);
  }
});

test("Google native stream completion accepts finishReason without OpenAI DONE sentinel", async () => {
  const googleRequest = protocolRequest("google");
  const config = protocolModelConfig("google", { streamMaxRetries: 0 });
  const googleClientFactory = () => ({
    models: {
      async generateContent() {
        throw new Error("not used");
      },
      async generateContentStream() {
        return (async function* () {
          yield {
            candidates: [{ content: { role: "model", parts: [{ text: "STREAM_OK" }] }, finishReason: "STOP", index: 0 }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          };
        })();
      },
    },
  } as never);

  const events = [];
  for await (const event of streamModel(googleRequest, config, { googleClientFactory })) {
    events.push(event);
  }

  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "STREAM_OK"), true);
  assert.equal(events.some((event) => event.type === "message_end"), true);
  assert.equal(events.some((event) => event.type === "error"), false);
});
