import assert from "node:assert/strict";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { buildProviderChatEndpoint } from "../../../src/model/providerEndpoint.js";

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

test("unknown custom models default to text-only input", () => {
  const config = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        models: { "text-model": {} },
      },
    },
  });

  assert.deepEqual(config.providers.custom.models["text-model"].multimodal.input, ["text"]);
});

test("custom models default to thinking support and opt into speed explicitly", () => {
  const defaulted = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        models: { "default-model": {} },
      },
    },
  });
  assert.equal(defaulted.providers.custom.models["default-model"].capabilities.supportsThinking, true);
  assert.equal(defaulted.providers.custom.models["default-model"].capabilities.supportsSpeed, undefined);

  const configured = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        models: {
          "speed-model": { capabilities: { supportsThinking: false, supportsSpeed: true } },
        },
      },
    },
  });
  assert.equal(configured.providers.custom.models["speed-model"].capabilities.supportsThinking, false);
  assert.equal(configured.providers.custom.models["speed-model"].capabilities.supportsSpeed, true);
});

test("all protocol defaults enable thinking for undeclared models", () => {
  for (const protocol of ["openai", "anthropic", "google"] as const) {
    const config = parseModelConfig({
      providers: {
        [`custom-${protocol}`]: {
          protocol,
          url: "https://example.test/v1",
          apiKey: "test-key",
          models: { "undeclared-model": {} },
        },
      },
    });
    assert.equal(
      config.providers[`custom-${protocol}`].models["undeclared-model"].capabilities.supportsThinking,
      true,
      protocol,
    );
  }
});

test("custom providers require an explicit protocol-compatible speed mapping", () => {
  const config = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        speedMapping: "openai_service_tier",
        models: { "speed-model": {} },
      },
    },
  });
  assert.equal(config.providers.custom.speedMapping, "openai_service_tier");

  assert.throws(
    () => parseModelConfig({
      providers: {
        custom: {
          protocol: "openai",
          url: "https://example.test/v1",
          apiKey: "test-key",
          speedMapping: "anthropic_speed",
          models: { "speed-model": {} },
        },
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_config_value",
  );
});

test("custom providers do not infer image input from a cross-provider model name", () => {
  const config = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        models: { "gpt-4o-mini": {} },
      },
    },
  });

  assert.deepEqual(config.providers.custom.models["gpt-4o-mini"].multimodal.input, ["text"]);
});

test("custom models use explicitly configured image input", () => {
  const config = parseModelConfig({
    providers: {
      custom: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        models: {
          "vision-model": {
            multimodal: { input: ["text", "image"] },
          },
        },
      },
    },
  });

  assert.deepEqual(
    config.providers.custom.models["vision-model"].multimodal.input,
    ["text", "image"],
  );
});

test("catalog models keep their catalog image capability when no override is set", () => {
  const config = parseModelConfig({
    providers: {
      openai: {
        apiKey: "test-key",
        models: { "gpt-4o-mini": {} },
      },
    },
  });

  assert.deepEqual(
    config.providers.openai.models["gpt-4o-mini"].multimodal.input,
    ["text", "image"],
  );
});

test("catalog model aliases keep their declared provider image capability", () => {
  const config = parseModelConfig({
    providers: {
      openai: {
        apiKey: "test-key",
        models: { "gpt-4o-2024-11-20": {} },
      },
    },
  });

  assert.deepEqual(
    config.providers.openai.models["gpt-4o-2024-11-20"].multimodal.input,
    ["text", "image"],
  );
});

test("orcarouter catalog provider resolves default URL, protocol and env api key", () => {
  const config = parseModelConfig({
    providers: {
      orcarouter: {
        models: { "orcarouter/fusion": {} },
      },
    },
  }, { env: { ORCAROUTER_API_KEY: "sk-orca-test" } });

  assert.equal(config.providers.orcarouter.url, "https://api.orcarouter.ai/v1");
  assert.equal(config.providers.orcarouter.protocol, "openai");
  assert.equal(config.providers.orcarouter.apiKey, "sk-orca-test");
});

test("orcarouter chat endpoint is built from the gateway base URL", () => {
  const endpoint = buildProviderChatEndpoint({
    protocol: "openai",
    baseUrl: "https://api.orcarouter.ai/v1",
  });

  assert.equal(endpoint, "https://api.orcarouter.ai/v1/chat/completions");
});
