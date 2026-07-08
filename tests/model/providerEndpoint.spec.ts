import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderChatEndpoint,
  buildProviderChatEndpointCandidates,
  buildProviderModelsEndpoint,
  buildProviderModelsEndpointCandidates,
  isExpectedProviderModelsResponseShape,
  isExpectedProviderResponseShape,
} from "../../src/model/providerEndpoint.js";

test("buildProviderChatEndpoint prefers protocol-versioned endpoints for root base URLs", () => {
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com" }),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }),
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-pro" }),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
  );
});

test("buildProviderChatEndpointCandidates falls back to default protocol versions", () => {
  assert.deepEqual(
    buildProviderChatEndpointCandidates({ protocol: "openai", baseUrl: "https://api.openai.com" }),
    ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/chat/completions"],
  );
  assert.deepEqual(
    buildProviderChatEndpointCandidates({ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }),
    ["https://api.anthropic.com/v1/messages", "https://api.anthropic.com/messages"],
  );
  assert.deepEqual(
    buildProviderChatEndpointCandidates({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-pro" }),
    [
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
      "https://generativelanguage.googleapis.com/models/gemini-pro:generateContent",
    ],
  );
});

test("buildProviderChatEndpoint does not duplicate existing version segments", () => {
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com/v1" }),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai-responses", baseUrl: "https://api.openai.com/v1/" }),
    "https://api.openai.com/v1/responses",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com/v1", model: "gemini-pro" }),
    "https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent",
  );
});

test("buildProviderChatEndpoint accepts full endpoint URLs", () => {
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com/v1/chat/completions" }),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai-responses", baseUrl: "https://api.openai.com/v1/responses" }),
    "https://api.openai.com/v1/responses",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1/messages" }),
    "https://api.anthropic.com/v1/messages",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent", model: "gemini-pro" }),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
  );
});

test("buildProviderChatEndpoint preserves provider-specific API version paths", () => {
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }),
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  );
  assert.equal(
    buildProviderChatEndpoint({ protocol: "openai", baseUrl: "https://api.z.ai/api/paas/v4" }),
    "https://api.z.ai/api/paas/v4/chat/completions",
  );
});

test("buildProviderModelsEndpoint matches protocol version rules", () => {
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com" }),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com/v1" }),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }),
    "https://api.anthropic.com/v1/models",
  );
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com" }),
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
  );
  assert.equal(
    buildProviderModelsEndpoint({ protocol: "openai", baseUrl: "https://api.openai.com/v1/models" }),
    "https://api.openai.com/v1/models",
  );
});

test("buildProviderModelsEndpointCandidates falls back to default protocol versions", () => {
  assert.deepEqual(
    buildProviderModelsEndpointCandidates({ protocol: "openai", baseUrl: "https://api.openai.com" }),
    ["https://api.openai.com/v1/models", "https://api.openai.com/models"],
  );
  assert.deepEqual(
    buildProviderModelsEndpointCandidates({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com" }),
    ["https://generativelanguage.googleapis.com/v1beta/models", "https://generativelanguage.googleapis.com/models"],
  );
});

test("provider response shape checks reject unrelated successful JSON", () => {
  assert.equal(isExpectedProviderResponseShape("openai", { ok: true }), false);
  assert.equal(isExpectedProviderResponseShape("openai", { choices: [] }), true);
  assert.equal(isExpectedProviderResponseShape("openai-responses", { output_text: "ok" }), true);
  assert.equal(isExpectedProviderResponseShape("anthropic", { type: "message" }), true);
  assert.equal(isExpectedProviderResponseShape("google", { candidates: [] }), true);
});

test("provider models response shape checks reject unrelated successful JSON", () => {
  assert.equal(isExpectedProviderModelsResponseShape("openai", { ok: true }), false);
  assert.equal(isExpectedProviderModelsResponseShape("openai", { data: [] }), true);
  assert.equal(isExpectedProviderModelsResponseShape("google", { models: [] }), true);
});
