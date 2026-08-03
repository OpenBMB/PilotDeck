import assert from "node:assert/strict";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { buildModelRequest } from "../../../src/model/index.js";
import {
  buildProviderChatEndpointCandidates,
  buildProviderModelsEndpointCandidates,
} from "../../../src/model/providerEndpoint.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";

test("DeepSeek catalog defaults to the official unversioned OpenAI-compatible base URL", () => {
  const config = parseModelConfig({
    providers: {
      deepseek: {
        apiKey: "sk-test",
        models: { "deepseek-v4-flash": {} },
      },
    },
  });

  assert.equal(config.providers.deepseek.url, "https://api.deepseek.com");
});

test("custom OpenAI-compatible providers do not inject a default output cap", () => {
  const config = parseModelConfig({
    providers: {
      local: {
        apiKey: "sk-test",
        protocol: "openai",
        url: "http://localhost:8000/v1",
        models: {
          "local-chat": {},
        },
      },
    },
  });

  const body = buildModelRequest({
    provider: "local",
    model: "local-chat",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    stream: true,
  }, config) as Record<string, unknown>;

  assert.equal(config.providers.local.catalog, false);
  assert.equal(body.max_tokens, undefined);
});

test("custom Anthropic-compatible providers do not inject a default output cap", () => {
  const config = parseModelConfig({
    providers: {
      local: {
        apiKey: "sk-test",
        protocol: "anthropic",
        url: "http://localhost:8000/v1",
        models: {
          "local-claude": {},
        },
      },
    },
  });

  const body = buildModelRequest({
    provider: "local",
    model: "local-claude",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    stream: true,
  }, config) as Record<string, unknown>;

  assert.equal(config.providers.local.catalog, false);
  assert.equal(body.max_tokens, undefined);
});

test("custom Google-compatible providers do not inject a default output cap", () => {
  const config = parseModelConfig({
    providers: {
      local: {
        apiKey: "sk-test",
        protocol: "google",
        url: "http://localhost:8000/v1beta",
        models: {
          "local-gemini": {},
        },
      },
    },
  });

  const body = buildModelRequest({
    provider: "local",
    model: "local-gemini",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    stream: true,
  }, config) as { config?: { maxOutputTokens?: number } };

  assert.equal(config.providers.local.catalog, false);
  assert.equal(body.config?.maxOutputTokens, undefined);
});

test("Kimi catalog defaults to the current Moonshot global endpoint", () => {
  const config = parseModelConfig({
    providers: {
      moonshot: {
        apiKey: "sk-test",
        models: { "kimi-k2.6": {} },
      },
    },
  });

  assert.equal(config.providers.moonshot.url, "https://api.moonshot.ai/v1");
});

test("DeepSeek endpoint candidates prefer the official unversioned paths", () => {
  assert.deepEqual(
    buildProviderChatEndpointCandidates({ protocol: "openai", baseUrl: "https://api.deepseek.com" }),
    [
      "https://api.deepseek.com/chat/completions",
      "https://api.deepseek.com/v1/chat/completions",
    ],
  );
  assert.deepEqual(
    buildProviderModelsEndpointCandidates({ protocol: "openai", baseUrl: "https://api.deepseek.com" }),
    [
      "https://api.deepseek.com/models",
      "https://api.deepseek.com/v1/models",
    ],
  );
});

test("generic OpenAI-compatible root endpoints still prefer the versioned path", () => {
  assert.deepEqual(
    buildProviderChatEndpointCandidates({ protocol: "openai", baseUrl: "https://api.example.com" }),
    [
      "https://api.example.com/v1/chat/completions",
      "https://api.example.com/chat/completions",
    ],
  );
});

test("Kimi K2.6 thinking uses Moonshot's thinking object instead of generic enable_thinking", () => {
  const body = buildKimiRequest("kimi-k2.6", { mode: "high", enabled: true }, 0.2);

  assert.deepEqual(body.thinking, { type: "enabled", keep: "all" });
  assert.equal(body.enable_thinking, undefined);
  assert.equal(body.temperature, undefined);
});

test("Kimi K2.6 off thinking uses Moonshot's disabled thinking object", () => {
  const body = buildKimiRequest("kimi-k2.6", { mode: "off", enabled: false });

  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.enable_thinking, undefined);
});

test("Kimi K3 thinking maps to reasoning_effort without a thinking object", () => {
  const body = buildKimiRequest("kimi-k3", { mode: "max", enabled: true }, 0.2);

  assert.equal(body.reasoning_effort, "max");
  assert.equal(body.thinking, undefined);
  assert.equal(body.enable_thinking, undefined);
  assert.equal(body.temperature, undefined);
});

test("DeepSeek V4 thinking keeps the official thinking object and reasoning effort", () => {
  const config = parseModelConfig({
    providers: {
      deepseek: {
        apiKey: "sk-test",
        models: { "deepseek-v4-pro": {} },
      },
    },
  });
  const request: CanonicalModelRequest = {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    stream: true,
    thinking: { mode: "high", enabled: true },
  };

  const body = buildModelRequest(request, config) as Record<string, unknown>;

  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
});

test("Anthropic empty cacheBreakpoints still cache the system prompt", () => {
  const config = parseModelConfig({
    providers: {
      anthropic: {
        apiKey: "sk-test",
        models: { "claude-sonnet-4-20250929": {} },
      },
    },
  });
  const request: CanonicalModelRequest = {
    provider: "anthropic",
    model: "claude-sonnet-4-20250929",
    messages: [{ role: "user", content: [{ type: "text", text: "Summarize" }] }],
    systemPrompt: "stable summary rubric",
    stream: true,
    cacheBreakpoints: [],
  };

  const body = buildModelRequest(request, config) as {
    system?: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  };

  assert.deepEqual(body.system, [
    {
      type: "text",
      text: "stable summary rubric",
      cache_control: { type: "ephemeral" },
    },
  ]);
});

function buildKimiRequest(
  model: string,
  thinking: NonNullable<CanonicalModelRequest["thinking"]>,
  temperature?: number,
): Record<string, unknown> {
  const config = parseModelConfig({
    providers: {
      moonshot: {
        apiKey: "sk-test",
        models: { [model]: {} },
      },
    },
  });
  const request: CanonicalModelRequest = {
    provider: "moonshot",
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    stream: true,
    thinking,
    temperature,
  };

  return buildModelRequest(request, config) as Record<string, unknown>;
}
