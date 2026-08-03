import test from "node:test";
import assert from "node:assert/strict";
import { streamModel } from "../../src/model/index.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelCapabilities,
  ModelConfig,
} from "../../src/model/index.js";

test("streamModel retries Anthropic-compatible terminated SSE errors", async () => {
  let calls = 0;
  const retries: string[] = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return sseResponse([
        { type: "error", error: { type: "provider_error", message: "terminated" } },
      ]);
    }
    return sseResponse([
      { type: "message_start", message: { role: "assistant" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
      { type: "message_stop" },
    ]);
  };

  const events: CanonicalModelEvent[] = [];
  for await (const event of streamModel(request(), config(), {
    fetch: fetchImpl as typeof fetch,
    onRetryProgress: (progress) => retries.push(progress.reason),
  })) {
    events.push(event);
  }

  assert.equal(calls, 2);
  assert.deepEqual(retries, ["network_error"]);
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.find((event) => event.type === "text_delta")?.type, "text_delta");
});

function request(): CanonicalModelRequest {
  return {
    provider: "test",
    model: "model",
    messages: [{ role: "user", content: [{ type: "text", text: "draft" }] }],
  };
}

function config(): ModelConfig {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: false,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
  };
  return {
    providers: {
      test: {
        id: "test",
        protocol: "anthropic",
        url: "https://example.invalid",
        apiKey: "test",
        headers: {},
        retry: { streamMaxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        models: { model: { id: "model", capabilities, multimodal: { input: ["text"] } } },
      },
    },
  };
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
