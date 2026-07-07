import assert from "node:assert/strict";
import test from "node:test";

import { buildModelRequest, parseModelConfig } from "../../src/model/index.js";
import type { CanonicalModelRequest } from "../../src/model/index.js";

test("Ollama provider uses catalog defaults and does not require apiKey", () => {
  const config = parseModelConfig({
    providers: {
      ollama: {
        models: {
          "qwen3:0.6b": {},
        },
      },
    },
  });

  const provider = config.providers.ollama;
  assert.equal(provider.protocol, "openai");
  assert.equal(provider.url, "http://localhost:11434/v1");
  assert.equal(provider.apiKey, "ollama");
  assert.equal(provider.models["qwen3:0.6b"].displayName, "Qwen3 0.6B (Ollama)");
  assert.equal(provider.models["qwen3:0.6b"].capabilities.supportsStreaming, true);
  assert.equal(provider.models["qwen3:0.6b"].capabilities.supportsToolUse, true);
});

test("Ollama provider builds OpenAI-compatible chat completions body", () => {
  const config = parseModelConfig({
    providers: {
      ollama: {
        models: {
          "llama3.1:8b": {},
        },
      },
    },
  });

  const request: CanonicalModelRequest = {
    provider: "ollama",
    model: "llama3.1:8b",
    stream: true,
    systemPrompt: "You are concise.",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ],
  };

  const body = buildModelRequest(request, config) as Record<string, unknown>;

  assert.equal(body.model, "llama3.1:8b");
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 8192);
  assert.deepEqual(body.messages, [
    { role: "system", content: "You are concise." },
    { role: "user", content: "hello" },
  ]);
});
