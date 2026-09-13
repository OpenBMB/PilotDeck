import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAIRequest } from "../../../src/model/providers/openai/request.js";
import type { CanonicalModelRequest, ModelDefinition } from "../../../src/model/index.js";

const model: ModelDefinition = {
  id: "test-model",
  multimodal: { input: ["text"] },
  capabilities: {
    supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: true,
    supportsThinking: false, supportsJsonSchema: true, supportsSystemPrompt: true,
    supportsPromptCache: false, maxContextTokens: 128000, maxOutputTokens: 4096,
  },
};

function request(metadata: Record<string, unknown>): CanonicalModelRequest {
  return {
    provider: "compatible", model: model.id,
    messages: [{ role: "user", content: [{ type: "text", text: "Read the supplied file." }] }],
    metadata,
  };
}

test("OpenAI-compatible child requests keep internal subagent identifiers out of the provider payload", () => {
  const input = request({ subagentId: "child-123", subagentType: "vision" });
  const wire = JSON.parse(JSON.stringify(buildOpenAIRequest(input, model)));
  assert.equal(Object.hasOwn(wire, "metadata"), false);
  assert.equal(input.metadata?.subagentId, "child-123", "internal tracing must remain intact");
});

test("OpenAI provider metadata still preserves caller-supplied tags", () => {
  const wire = buildOpenAIRequest(request({ subagentId: "child-123", subagentType: "vision", project: "demo", batch: 3 }), model);
  assert.deepEqual(wire.metadata, { project: "demo", batch: "3" });
});
