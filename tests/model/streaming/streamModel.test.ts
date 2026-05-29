import test from "node:test";
import assert from "node:assert/strict";

import { streamModel, type ModelTransport } from "../../../src/model/streaming/streamModel.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../../src/model/protocol/multimodal.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelConfig } from "../../../src/model/protocol/canonical.js";

const MODEL_CONFIG: ModelConfig = {
  providers: {
    openai: {
      id: "openai",
      protocol: "openai",
      url: "https://example.test/v1",
      apiKey: "test-key",
      headers: {},
      models: {
        "test-model": {
          id: "test-model",
          capabilities: {
            ...DEFAULT_MODEL_CAPABILITIES,
            supportsToolUse: true,
            supportsStreaming: true,
          },
          multimodal: DEFAULT_MULTIMODAL_CONSTRAINTS,
        },
      },
    },
  },
};

const REQUEST: CanonicalModelRequest = {
  provider: "openai",
  model: "test-model",
  stream: true,
  messages: [{ role: "user", content: [{ type: "text", text: "run a tool" }] }],
  tools: [{ name: "read_file", inputSchema: { type: "object", properties: {} } }],
};

test("streamModel does not retry from scratch after partial tool call content", async () => {
  let fetchCalls = 0;
  const fetchImpl: ModelTransport = async () => {
    fetchCalls += 1;
    return new Response(erroringSseStream([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "{}" } }] } }] }),
    ], new Error("socket hang up")));
  };

  const events: CanonicalModelEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of streamModel(REQUEST, MODEL_CONFIG, { fetch: fetchImpl })) {
      events.push(event);
    }
  }, /socket hang up/);

  assert.equal(fetchCalls, 1);
  assert.equal(events.filter((event) => event.type === "tool_call_start").length, 1);
});

test("streamModel treats network errors after message_end as completed", async () => {
  let fetchCalls = 0;
  const fetchImpl: ModelTransport = async () => {
    fetchCalls += 1;
    return new Response(erroringSseStream([
      sse({ choices: [{ delta: { content: "done" } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ], new Error("network reset after finish")));
  };

  const events: CanonicalModelEvent[] = [];
  for await (const event of streamModel(REQUEST, MODEL_CONFIG, { fetch: fetchImpl })) {
    events.push(event);
  }

  assert.equal(fetchCalls, 1);
  assert.equal(events.some((event) => event.type === "message_end"), true);
  assert.equal(events.some((event) => event.type === "error"), false);
});

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function erroringSseStream(chunks: string[], error: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      controller.error(error);
    },
  });
}
