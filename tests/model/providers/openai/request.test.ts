import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MODEL_CAPABILITIES } from "../../../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../../../src/model/protocol/multimodal.js";
import { buildOpenAIRequest } from "../../../../src/model/providers/openai/request.js";
import type { ModelDefinition } from "../../../../src/model/protocol/canonical.js";

const model: ModelDefinition = {
  id: "test-model",
  capabilities: DEFAULT_MODEL_CAPABILITIES,
  multimodal: DEFAULT_MULTIMODAL_CONSTRAINTS,
};

test("OpenAI assistant tool-call messages include empty content when no text is present", () => {
  const body = buildOpenAIRequest({
    provider: "openai",
    model: "test-model",
    stream: true,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_123",
            name: "lookup",
            input: { q: "pilotdeck" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_123",
            content: [{ type: "text", text: "ok" }],
          },
        ],
      },
    ],
  }, model);

  assert.equal(body.messages[0]?.role, "assistant");
  assert.equal(body.messages[0]?.content, "");
  assert.equal(Array.isArray(body.messages[0]?.tool_calls), true);
});
