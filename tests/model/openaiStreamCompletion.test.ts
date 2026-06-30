import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { streamModel } from "../../src/model/streaming/streamModel.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelConfig } from "../../src/model/index.js";

const modelConfig: ModelConfig = {
  providers: {
    openai: {
      id: "openai",
      protocol: "openai",
      url: "https://api.openai.com/v1",
      apiKey: "test-key",
      headers: {},
      retry: { streamMaxRetries: 0 },
      models: {
        "gpt-test": {
          id: "gpt-test",
          capabilities: {
            supportsToolUse: true,
            supportsStreaming: true,
            supportsParallelToolCalls: true,
            supportsThinking: false,
            supportsJsonSchema: true,
            supportsSystemPrompt: true,
            supportsPromptCache: false,
            maxContextTokens: 128_000,
            maxOutputTokens: 16_384,
          },
          multimodal: { input: ["text"] },
        },
      },
    },
  },
};

const request: CanonicalModelRequest = {
  provider: "openai",
  model: "gpt-test",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  stream: true,
};

describe("OpenAI-compatible stream completion sentinels", () => {
  it("accepts raw [DONE] as a completed stream", async () => {
    const events: CanonicalModelEvent[] = [];
    for await (const event of streamModel(request, modelConfig, {
      fetch: async () => sseResponse([
        `data: ${JSON.stringify({ id: "1", choices: [{ delta: { content: "hi" } }] })}`,
        "data: [DONE]",
      ]),
    })) {
      events.push(event);
    }

    assert.deepEqual(events.map((event) => event.type), [
      "request_started",
      "message_start",
      "text_delta",
    ]);
  });

  it("accepts raw [DONE] without a trailing SSE delimiter", async () => {
    const events: CanonicalModelEvent[] = [];
    for await (const event of streamModel(request, modelConfig, {
      fetch: async () => sseResponse([
        `data: ${JSON.stringify({ id: "1", choices: [{ delta: { content: "hi" } }] })}`,
        "data: [DONE]",
      ], { trailingDelimiter: false }),
    })) {
      events.push(event);
    }

    assert.deepEqual(events.map((event) => event.type), [
      "request_started",
      "message_start",
      "text_delta",
    ]);
  });

  it("accepts provider finish_reason without a trailing SSE delimiter", async () => {
    const events: CanonicalModelEvent[] = [];
    for await (const event of streamModel(request, modelConfig, {
      fetch: async () => sseResponse([
        `data: ${JSON.stringify({ id: "1", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      ], { trailingDelimiter: false }),
    })) {
      events.push(event);
    }

    assert.deepEqual(events.map((event) => event.type), [
      "request_started",
      "message_start",
      "message_end",
    ]);
  });

  it("rejects EOF without [DONE] or provider message_end", async () => {
    const events: CanonicalModelEvent[] = [];
    await assert.rejects(
      async () => {
        for await (const event of streamModel(request, modelConfig, {
          fetch: async () => sseResponse([
            `data: ${JSON.stringify({ id: "1", choices: [{ delta: { content: "partial" } }] })}`,
          ]),
        })) {
          events.push(event);
        }
      },
      /ended before provider completion sentinel/i,
    );

    assert.deepEqual(events.map((event) => event.type), [
      "request_started",
      "message_start",
      "text_delta",
    ]);
  });
});

function sseResponse(
  lines: string[],
  options: { trailingDelimiter?: boolean } = {},
): Response {
  const encoder = new TextEncoder();
  const trailingDelimiter = options.trailingDelimiter ?? true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${lines.join("\n\n")}${trailingDelimiter ? "\n\n" : ""}`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}
