import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { CanonicalModelRequest, ModelConfig } from "../../src/model/protocol/canonical.js";
import { resolveGoogleEndpoint } from "../../src/model/providers/google/client.js";
import { normalizeGoogleToolSchema } from "../../src/model/providers/google/schema.js";
import { complete, streamModel } from "../../src/model/streaming/streamModel.js";

test("Google custom base URLs retain the native v1beta endpoint", () => {
  assert.deepEqual(resolveGoogleEndpoint("https://llm-center.modelbest.cn/llm"), {
    baseUrl: "https://llm-center.modelbest.cn/llm/",
    apiVersion: "v1beta",
  });
});

test("Google tool schema flattens top-level object unions without leaking union keywords", () => {
  const normalized = normalizeGoogleToolSchema({
    title: "operation",
    anyOf: [
      {
        type: "object",
        properties: {
          kind: { type: "string", const: "read" },
          path: { type: "string" },
        },
        required: ["kind", "path"],
      },
      {
        type: "object",
        properties: {
          kind: { type: "string", const: "write" },
          content: { type: "string" },
        },
        required: ["kind", "content"],
      },
    ],
  });

  assert.deepEqual(normalized, {
    title: "operation",
    type: "object",
    properties: {
      kind: { type: "string", enum: ["read", "write"] },
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["kind"],
  });
  assert.equal("anyOf" in normalized, false);
  assert.equal("oneOf" in normalized, false);
});

test("Google complete preserves SDK abort errors", async () => {
  const abort = new DOMException("cancelled", "AbortError");
  await assert.rejects(
    () => complete(modelRequest(), googleConfig(), {
      googleClientFactory: () => ({
        models: {
          generateContent: async () => { throw abort; },
          generateContentStream: async () => { throw new Error("unexpected stream call"); },
        },
      }),
    }),
    error => error === abort,
  );
});

test("Google stream preserves SDK abort errors instead of emitting provider errors", async () => {
  const abort = new DOMException("cancelled", "AbortError");
  const events = streamModel(modelRequest(), googleConfig(), {
    googleClientFactory: () => ({
      models: {
        generateContent: async () => { throw new Error("unexpected complete call"); },
        generateContentStream: async () => { throw abort; },
      },
    }),
  });
  const iterator = events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "request_started");
  await assert.rejects(() => iterator.next(), error => error === abort);
});

function modelRequest(): CanonicalModelRequest {
  return {
    provider: "google",
    model: "gemini-test",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function googleConfig(): ModelConfig {
  return {
    providers: {
      google: {
        id: "google",
        protocol: "google",
        url: "https://generativelanguage.googleapis.com",
        apiKey: "test-key",
        headers: {},
        retry: { requestMaxRetries: 0, streamMaxRetries: 0 },
        models: {
          "gemini-test": {
            id: "gemini-test",
            capabilities: DEFAULT_MODEL_CAPABILITIES,
            multimodal: { input: ["text"] },
          },
        },
      },
    },
  };
}
