import assert from "node:assert/strict";
import test from "node:test";
import { complete } from "../../src/model/streaming/streamModel.js";
import type { CanonicalModelRequest, ModelConfig } from "../../src/model/protocol/canonical.js";

const modelConfig: ModelConfig = {
  providers: {
    openai: {
      id: "openai",
      protocol: "openai",
      url: "https://api.openai.com",
      apiKey: "sk-test",
      headers: {},
      retry: { requestMaxRetries: 0 },
      models: {
        "gpt-test": {
          id: "gpt-test",
          capabilities: {
            supportsToolUse: false,
            supportsStreaming: true,
            supportsParallelToolCalls: false,
            supportsThinking: false,
            supportsJsonSchema: false,
            supportsSystemPrompt: true,
            supportsPromptCache: false,
            maxContextTokens: 128,
            maxOutputTokens: 16,
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
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  maxOutputTokens: 8,
  stream: false,
};

test("complete falls back when protocol-versioned endpoint returns unexpected JSON", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === "https://api.openai.com/v1/chat/completions") {
      return Response.json({ ok: true });
    }
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  };

  const response = await complete(request, modelConfig, { fetch: fetchImpl });

  assert.deepEqual(calls, [
    "https://api.openai.com/v1/chat/completions",
    "https://api.openai.com/chat/completions",
  ]);
  assert.deepEqual(response.content, [{ type: "text", text: "ok" }]);
});
