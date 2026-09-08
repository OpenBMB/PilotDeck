import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRequest } from "../../../src/model/index.js";
import { buildProviderHeaders } from "../../../src/model/streaming/streamModel.js";
import type {
  CanonicalModelRequest,
  ModelCapabilities,
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
  ProviderConfig,
} from "../../../src/model/index.js";

test("all provider request builders pass speed only when configured", () => {
  for (const protocol of ["openai", "openai-responses", "anthropic"] as const) {
    const withSpeed = buildModelRequest(request(protocol, 0.65), modelConfig(protocol)) as Record<string, unknown>;
    if (protocol === "anthropic") {
      assert.equal(withSpeed.speed, "fast", `${protocol} should map speed to its native value`);
    } else {
      assert.equal(withSpeed.service_tier, "priority", `${protocol} should map speed to service_tier`);
      assert.equal(withSpeed.speed, undefined, `${protocol} should not send numeric speed`);
    }

    const withoutSpeed = buildModelRequest(request(protocol), modelConfig(protocol)) as Record<string, unknown>;
    assert.equal(withoutSpeed.speed, undefined, `${protocol} should omit unset speed`);
    assert.equal(withoutSpeed.service_tier, undefined, `${protocol} should omit unset service tier`);
  }
  assert.throws(
    () => buildModelRequest(request("google", 0.65), modelConfig("google")),
    (error: unknown) => (error as { code?: string }).code === "unsupported_speed",
  );
});

test("native speed mappings preserve low and high normalized tiers", () => {
  const openaiLow = buildModelRequest(request("openai", 0.49), modelConfig("openai")) as Record<string, unknown>;
  const openaiHigh = buildModelRequest(request("openai", 0.5), modelConfig("openai")) as Record<string, unknown>;
  const anthropicLow = buildModelRequest(request("anthropic", 0.49), modelConfig("anthropic")) as Record<string, unknown>;
  const anthropicHigh = buildModelRequest(request("anthropic", 0.5), modelConfig("anthropic")) as Record<string, unknown>;
  assert.equal(openaiLow.service_tier, undefined);
  assert.equal(openaiHigh.service_tier, "priority");
  assert.equal(anthropicLow.speed, undefined);
  assert.equal(anthropicHigh.speed, "fast");
});

test("anthropic fast mode adds the required beta header and preserves existing beta values", () => {
  const provider = modelConfig("anthropic").providers.anthropic;
  provider.headers = { "anthropic-beta": "prompt-caching-2024-07-31" };
  const headers = buildProviderHeaders(provider, { speed: "fast" }) as Record<string, string>;
  assert.equal(headers["anthropic-beta"], "prompt-caching-2024-07-31, fast-mode-2026-02-01");

  const standardHeaders = buildProviderHeaders(provider, {}) as Record<string, string>;
  assert.equal(standardHeaders["anthropic-beta"], "prompt-caching-2024-07-31");

  const duplicateHeaders = buildProviderHeaders({
    ...provider,
    headers: { "Anthropic-Beta": "fast-mode-2026-02-01" },
  }, { speed: "fast" }) as Record<string, string>;
  assert.equal(duplicateHeaders["Anthropic-Beta"], "fast-mode-2026-02-01");
});

test("shared request validation rejects speed for models without the capability", () => {
  for (const protocol of ["openai", "openai-responses", "anthropic"] as const) {
    assert.throws(
      () => buildModelRequest(request(protocol, 0.65), modelConfig(protocol, false)),
      (error: unknown) => (error as { code?: string }).code === "unsupported_speed",
    );
  }
});

test("canonical request validation rejects invalid speed values before provider mapping", () => {
  for (const speed of [-0.1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildModelRequest(request("openai", speed), modelConfig("openai")),
      (error: unknown) => (error as { code?: string }).code === "invalid_speed",
    );
  }
});

function request(provider: ModelProtocol, speed?: number): CanonicalModelRequest {
  return {
    provider,
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    stream: true,
    ...(speed === undefined ? {} : { speed }),
  };
}

function modelConfig(protocol: ModelProtocol, supportsSpeed = true): ModelConfig {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: true,
    supportsSpeed,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
  };
  const model: ModelDefinition = {
    id: "test-model",
    capabilities,
    multimodal: { input: ["text"] },
  };
  const provider: ProviderConfig = {
    id: protocol,
    protocol,
    url: "https://example.invalid/v1",
    apiKey: "test-key",
    headers: {},
    speedMapping: protocol === "anthropic" ? "anthropic_speed" : protocol === "google" ? undefined : "openai_service_tier",
    models: { "test-model": model },
  };
  return { providers: { [protocol]: provider } };
}
