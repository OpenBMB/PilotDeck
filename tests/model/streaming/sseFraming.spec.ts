import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
} from "../../../src/model/protocol/canonical.js";
import { ModelProviderError } from "../../../src/model/protocol/errors.js";
import { streamModel } from "../../../src/model/streaming/streamModel.js";

test("OpenAI Responses public stream supports all SSE line endings and framing details", async () => {
  const chunks = [
    ": keepalive\r\nevent: response.created\r\ndata: {\"type\":\"response.created\",\r\n",
    "data: \"response\":{\"id\":\"resp_1\"}}\r",
    "\nid: ignored\r\n\r",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\r\r",
    "retry: 10\ndata: {\"type\":\"response.completed\",\ndata: \"response\":{\"id\":\"resp_1\"}}\n\n",
    "data: [DONE]",
  ];

  const events = await collectStream("openai-responses", chunks);
  assert.deepEqual(events.map(eventShape), [
    "request_started",
    "message_start",
    "text_delta:OK",
    "message_end:stop",
  ]);
});

test("OpenAI-compatible public stream preserves ordinary LF behavior", async () => {
  const events = await collectStream("openai", [
    sse({ id: "chat_1", choices: [{ delta: { role: "assistant" } }] }),
    sse({ id: "chat_1", choices: [{ delta: { content: "hello" } }] }),
    sse({ id: "chat_1", choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]);

  assert.deepEqual(events.map(eventShape), [
    "request_started",
    "message_start",
    "text_delta:hello",
    "message_end:stop",
  ]);
});

test("malformed SSE JSON is a stable non-retryable protocol error without duplicate content", async () => {
  let fetchCalls = 0;
  const events: CanonicalModelEvent[] = [];
  const config = modelConfig("openai-responses");

  await assert.rejects(async () => {
    for await (const event of streamModel(canonicalRequest(), config, {
      fetch: (async () => {
        fetchCalls += 1;
        return streamResponse([
          sse({ type: "response.output_text.delta", delta: "once" }),
          "data: {not-json}\n\n",
        ]);
      }) as typeof fetch,
    })) {
      events.push(event);
    }
  }, (error: unknown) => {
    assert.ok(error instanceof ModelProviderError);
    assert.deepEqual(error.error, {
      provider: "test-provider",
      protocol: "openai-responses",
      code: "provider_error",
      message: "Provider stream contained malformed JSON in an SSE data event.",
      retryable: false,
      raw: "{not-json}",
    });
    return true;
  });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(events.map(eventShape), [
    "request_started",
    "message_start",
    "text_delta:once",
  ]);
});

async function collectStream(protocol: ModelProtocol, chunks: string[]): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of streamModel(canonicalRequest(), modelConfig(protocol), {
    fetch: (async () => streamResponse(chunks)) as typeof fetch,
  })) {
    events.push(event);
  }
  return events;
}

function canonicalRequest(): CanonicalModelRequest {
  return {
    provider: "test-provider",
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function modelConfig(protocol: ModelProtocol): ModelConfig {
  const model: ModelDefinition = {
    id: "test-model",
    capabilities: {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking: true,
      supportsJsonSchema: true,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 10_000,
      maxOutputTokens: 1_000,
    },
    multimodal: { input: ["text"] },
  };
  return {
    providers: {
      "test-provider": {
        id: "test-provider",
        protocol,
        url: "https://provider.example/v1",
        apiKey: "test-key",
        headers: {},
        models: { [model.id]: model },
        retry: { streamMaxRetries: 2, baseDelayMs: 1, jitter: 0 },
      },
    },
  };
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function eventShape(event: CanonicalModelEvent): string {
  if (event.type === "text_delta") return `${event.type}:${event.text}`;
  if (event.type === "message_end") return `${event.type}:${event.finishReason}`;
  return event.type;
}
