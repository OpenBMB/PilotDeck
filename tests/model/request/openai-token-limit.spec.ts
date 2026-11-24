import assert from "node:assert/strict";
import test from "node:test";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { complete } from "../../../src/model/streaming/streamModel.js";

const cases = [
  { label: "OpenAI endpoint", url: "https://api.openai.com/v1", expected: { max_completion_tokens: 128 } },
  {
    label: "OpenAI endpoint with a legacy override",
    url: "https://api.openai.com/v1",
    extraBody: { max_tokens: 256 },
    expected: { max_completion_tokens: 256 },
  },
  {
    label: "OpenAI endpoint with both overrides",
    url: "https://api.openai.com/v1",
    extraBody: { max_tokens: 256, max_completion_tokens: 512 },
    expected: { max_completion_tokens: 512 },
  },
  { label: "compatible endpoint", url: "https://api.openai.com.example.test/v1", expected: { max_tokens: 128 } },
];

for (const { label, url, extraBody, expected } of cases) {
  test(`sends the correct Chat Completions token limit: ${label}`, async () => {
    const config = parseModelConfig({
      providers: {
        custom: { protocol: "openai", url, apiKey: "test", extraBody, models: { "test-model": {} } },
      },
    });
    let payload: Record<string, unknown> = {};
    await complete({
      provider: "custom",
      model: "test-model",
      maxOutputTokens: 128,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }, config, {
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      },
    });
    const fields = Object.entries(payload).filter(([name]) => name === "max_tokens" || name === "max_completion_tokens");
    assert.deepEqual(Object.fromEntries(fields), expected);
  });
}
