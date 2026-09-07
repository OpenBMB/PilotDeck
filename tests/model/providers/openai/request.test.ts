import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenAIRequest } from "../../../../src/model/providers/openai/request.js";
import type {
  CanonicalModelRequest,
  ModelDefinition,
} from "../../../../src/model/protocol/canonical.js";

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
    maxContextTokens: 8192,
    maxOutputTokens: 1024,
  },
  multimodal: {
    input: ["text"],
  },
};

test("serializes assistant tool calls with explicit empty content", () => {
  const request: CanonicalModelRequest = {
    model: "test-model",
    provider: "openai",
    stream: true,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Call a tool." }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_test_1",
            name: "noop",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_test_1",
            content: [{ type: "text", text: "ok" }],
          },
        ],
      },
    ],
  };

  const body = buildOpenAIRequest(request, model);
  const assistantMessage = body.messages.find((message) => message.role === "assistant");

  assert.equal(assistantMessage?.content, "");
  assert.deepEqual(assistantMessage?.tool_calls, [
    {
      id: "call_test_1",
      type: "function",
      function: {
        name: "noop",
        arguments: "{}",
      },
    },
  ]);
});
