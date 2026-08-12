import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAIRequest,
} from "../../../src/model/providers/openai/request.js";
import { validateModelRequest } from "../../../src/model/request/validateModelRequest.js";
import type {
  CanonicalModelRequest,
  ModelConfig,
  ModelDefinition,
  ProviderConfig,
} from "../../../src/model/protocol/canonical.js";
import type { ModelCapabilities } from "../../../src/model/protocol/capabilities.js";
import {
  collectRequiredInputModalities,
  supportsRequiredModalities,
} from "../../../src/router/utils/mediaRequirements.js";

test("video input is validated, routed, and serialized for compatible models", () => {
  const request: CanonicalModelRequest = {
    provider: "compatible",
    model: "video-model",
    messages: [{
      role: "user",
      content: [{
        type: "video",
        source: "url",
        data: "https://example.com/input.mp4",
        mimeType: "video/mp4",
      }],
    }],
  };
  const config = modelConfig();

  const { provider, model } = validateModelRequest(request, config);
  const required = collectRequiredInputModalities(request.messages);
  const body = buildOpenAIRequest(request, model, provider);

  assert.deepEqual(required, ["video"]);
  assert.equal(supportsRequiredModalities(model.multimodal, required), true);
  assert.deepEqual(body.messages, [{
    role: "user",
    content: [{
      type: "video_url",
      video_url: { url: "https://example.com/input.mp4" },
    }],
  }]);
});

function modelConfig(): ModelConfig {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: true,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 16_384,
  };
  const model: ModelDefinition = {
    id: "video-model",
    capabilities,
    multimodal: { input: ["text", "image", "video"] },
  };
  const provider: ProviderConfig = {
    id: "compatible",
    protocol: "openai",
    url: "https://example.invalid/v1",
    apiKey: "test",
    headers: {},
    models: { [model.id]: model },
  };
  return { providers: { [provider.id]: provider } };
}
