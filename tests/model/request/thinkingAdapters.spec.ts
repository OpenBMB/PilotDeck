import assert from "node:assert/strict";
import test from "node:test";

import { buildModelRequest } from "../../../src/model/index.js";
import { ModelRequestError } from "../../../src/model/index.js";
import type { CanonicalModelRequest, ModelCapabilities, ModelConfig, ModelDefinition, ModelProtocol, ProviderConfig } from "../../../src/model/index.js";

const capabilities: ModelCapabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: true,
  supportsThinking: true,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 128_000,
  maxOutputTokens: 16_384,
};

const messages: CanonicalModelRequest["messages"] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

test("GLM-5.2 Max sends thinking enabled and reasoning_effort=max", () => {
  const body = bodyFor("zai", "openai", "glm-5.2", { mode: "max", enabled: true });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
});

test("GLM-4.6 High sends thinking enabled without reasoning_effort", () => {
  const body = bodyFor("zai", "openai", "glm-4.6", { mode: "high", enabled: true });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, undefined);
});

test("Qwen hybrid Off and High map to enable_thinking and budget", () => {
  const off = bodyFor("dashscope", "openai", "qwen3-next-hybrid", { mode: "off", enabled: false });
  assert.equal(off.enable_thinking, false);

  const high = bodyFor("dashscope", "openai", "qwen3-next-hybrid", { mode: "high", enabled: true });
  assert.equal(high.enable_thinking, true);
  assert.equal(high.thinking_budget, 24576);
});

test("DeepSeek Medium and Max legalize to high/max effort", () => {
  const medium = bodyFor("deepseek", "openai", "deepseek-chat", { mode: "medium", enabled: true });
  assert.deepEqual(medium.thinking, { type: "enabled" });
  assert.equal(medium.reasoning_effort, "high");

  const max = bodyFor("deepseek", "openai", "deepseek-chat", { mode: "max", enabled: true });
  assert.equal(max.reasoning_effort, "max");
});

test("ModelBest Qwen uses thinking/reasoning_effort instead of enable_thinking", () => {
  const high = bodyFor("qwen", "openai", "QWEN_40e5sh", { mode: "high", enabled: true }, "https://llm-center.ali.modelbest.cn/llm/v1");
  assert.deepEqual(high.thinking, { type: "enabled" });
  assert.equal(high.reasoning_effort, "high");
  assert.equal(high.enable_thinking, undefined);
});

test("ModelBest DeepSeek avoids combining thinking and reasoning_effort", () => {
  const high = bodyFor("deepseek", "openai", "DEEPSEEK_rtwgny", { mode: "high", enabled: true }, "https://llm-center.ali.modelbest.cn/llm/v1");
  assert.deepEqual(high.thinking, { type: "enabled" });
  assert.equal(high.reasoning_effort, undefined);
});

test("Kimi K2.6 Off disables thinking without effort or budget", () => {
  const body = bodyFor("moonshot", "openai", "kimi-k2.6", { mode: "off", enabled: false });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking_budget, undefined);
  assert.equal(body.temperature, undefined);
});

test("MiniMax M2 supports Off and reasoning split without fake effort", () => {
  const off = bodyFor("minimax", "openai", "minimax-m2", { mode: "off", enabled: false });
  assert.deepEqual(off.thinking, { type: "disabled" });

  const body = bodyFor("minimax", "openai", "minimax-m2", { mode: "medium", enabled: true });
  assert.equal(body.reasoning_split, true);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking_budget, undefined);
});

test("GPT-5.5 Pro Low legalizes to Medium", () => {
  const body = bodyFor("openai", "openai-responses", "gpt-5.5-pro", { mode: "low", enabled: true });
  assert.deepEqual(body.reasoning, { effort: "medium" });
});

test("Gemini 3.1 Pro uses thinkingLevel not thinkingBudget", () => {
  const body = bodyFor("google", "google", "gemini-3.1-pro", { mode: "medium", enabled: true });
  assert.deepEqual(body.config.thinkingConfig, { includeThoughts: true, thinkingLevel: "medium" });
});

test("unknown explicit thinking mode returns an actionable unsupported error", () => {
  assert.throws(
    () => bodyFor("local", "openai", "plain-chat", { mode: "high", enabled: true }, "https://local.example.invalid/v1", false),
    (error: unknown) => error instanceof ModelRequestError
      && error.code === "unsupported_thinking"
      && /Switch thinking strength back to Default/.test(error.message),
  );
});

test("legacy disabled thinking remains a no-op for ordinary models", () => {
  const body = bodyFor("local", "openai", "plain-chat", { enabled: false }, "https://local.example.invalid/v1", false);
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.enable_thinking, undefined);
});

function bodyFor(providerId: string, protocol: ModelProtocol, modelId: string, thinking: CanonicalModelRequest["thinking"], url?: string, supportsThinking = true): any {
  const request: CanonicalModelRequest = {
    provider: providerId,
    model: modelId,
    messages,
    stream: true,
    thinking,
  };
  return buildModelRequest(request, configFor(providerId, protocol, modelId, url, supportsThinking)) as any;
}

function configFor(providerId: string, protocol: ModelProtocol, modelId: string, url?: string, supportsThinking = true): ModelConfig {
  const model: ModelDefinition = {
    id: modelId,
    capabilities: { ...capabilities, supportsThinking },
    multimodal: { input: ["text"] },
  };
  const provider: ProviderConfig = {
    id: providerId,
    protocol,
    url: url ?? `https://${providerId}.example.invalid/v1`,
    apiKey: "test",
    headers: {},
    models: { [modelId]: model },
  };
  return { providers: { [providerId]: provider } };
}
