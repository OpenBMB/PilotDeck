import assert from "node:assert/strict";
import test from "node:test";

import { buildModelRequest, cloneMessages } from "../../../src/model/index.js";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
  ModelConfig,
  ModelDefinition,
  ProviderConfig,
} from "../../../src/model/index.js";
import type { ModelCapabilities } from "../../../src/model/index.js";

test("model request builders tolerate malformed messages with missing content", () => {
  const malformed = { role: "assistant" } as unknown as CanonicalMessage;
  const request: CanonicalModelRequest = {
    provider: "local",
    model: "text",
    stream: true,
    messages: [
      { role: "user", content: [{ type: "text", text: "start" }] },
      malformed,
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ],
  };

  assert.doesNotThrow(() => buildModelRequest(request, modelConfig()));
});

test("cloneMessages normalizes malformed messages with missing content", () => {
  const malformed = { role: "assistant" } as unknown as CanonicalMessage;

  assert.deepEqual(cloneMessages([malformed]), [{ role: "assistant", content: [] }]);
});

function modelConfig(): ModelConfig {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: false,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
  };
  const models: Record<string, ModelDefinition> = {
    text: {
      id: "text",
      capabilities,
      multimodal: { input: ["text"] },
    },
  };
  const provider: ProviderConfig = {
    id: "local",
    protocol: "openai",
    url: "https://example.invalid/v1",
    apiKey: "test",
    headers: {},
    models,
  };
  return { providers: { local: provider } };
}
