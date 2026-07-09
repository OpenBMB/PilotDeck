import assert from "node:assert/strict";
import test from "node:test";

import { ModelConfigError, parseModelConfig } from "../../src/model/index.js";

const anthropicModelId = "claude-sonnet-4-5-20250929";

function catalogAnthropicProvider(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      anthropic: {
        ...extra,
        models: {
          [anthropicModelId]: {},
        },
      },
    },
  };
}

function assertMissingApiKey(fn: () => void, messagePattern?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal(error instanceof ModelConfigError, true);
    assert.equal((error as ModelConfigError).code, "missing_api_key");
    if (messagePattern) {
      assert.match((error as Error).message, messagePattern);
    }
    return true;
  });
}

test("parseModelConfig resolves catalog apiKeyEnvVar when provider apiKey is absent", () => {
  const config = parseModelConfig(catalogAnthropicProvider(), {
    env: { ANTHROPIC_API_KEY: " sk-test-from-env \n" },
  });

  assert.equal(config.providers.anthropic.protocol, "anthropic");
  assert.equal(config.providers.anthropic.url, "https://api.anthropic.com");
  assert.equal(config.providers.anthropic.apiKey, "sk-test-from-env");
});

test("parseModelConfig keeps explicit env apiKey resolution ahead of catalog apiKeyEnvVar", () => {
  const config = parseModelConfig(catalogAnthropicProvider({
    apiKey: "${CUSTOM_ANTHROPIC_KEY}",
  }), {
    env: {
      ANTHROPIC_API_KEY: "catalog-key",
      CUSTOM_ANTHROPIC_KEY: "explicit-key",
    },
  });

  assert.equal(config.providers.anthropic.apiKey, "explicit-key");
});

test("parseModelConfig reports missing catalog env apiKey as missing_api_key", () => {
  assertMissingApiKey(() => {
    parseModelConfig(catalogAnthropicProvider(), { env: {} });
  }, /ANTHROPIC_API_KEY/);
});

test("parseModelConfig still requires apiKey for non-catalog providers", () => {
  assertMissingApiKey(() => {
    parseModelConfig({
      providers: {
        custom: {
          protocol: "openai",
          url: "https://example.test/v1",
          models: { "custom-model": {} },
        },
      },
    }, { env: { OPENAI_API_KEY: "sk-test-from-env" } });
  });
});
