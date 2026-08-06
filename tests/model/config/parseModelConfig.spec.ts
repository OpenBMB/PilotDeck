import assert from "node:assert/strict";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";

test("catalog provider resolves api key from default env var when apiKey is omitted", () => {
  const config = parseModelConfig({
    providers: {
      openai: {
        models: { "gpt-4o-mini": {} },
      },
    },
  }, { env: { OPENAI_API_KEY: " sk-env " } });

  assert.equal(config.providers.openai.apiKey, "sk-env");
});

test("catalog provider resolves api key from default env var when apiKey is blank", () => {
  const config = parseModelConfig({
    providers: {
      google: {
        apiKey: "  ",
        models: { "gemini-2.0-flash": {} },
      },
    },
  }, { env: { GEMINI_API_KEY: " gemini-env " } });

  assert.equal(config.providers.google.apiKey, "gemini-env");
});

test("Codex subscription provider does not require an API key", () => {
  const config = parseModelConfig({
    providers: {
      codex: {
        models: { "gpt-5.6-sol": {} },
      },
    },
  });

  assert.equal(config.providers.codex.protocol, "openai-responses");
  assert.equal(config.providers.codex.url, "https://chatgpt.com/backend-api/codex");
  assert.equal(config.providers.codex.apiKey, "");
});
