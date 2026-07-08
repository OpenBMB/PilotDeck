import test from "node:test";
import assert from "node:assert/strict";
import { complete, buildModelRequest, normalizeModelError } from "../../src/model/index.js";
import type { CanonicalModelRequest, ModelConfig } from "../../src/model/index.js";
import { ContextOverflowRecovery } from "../../src/context/index.js";
import { LlmMemoryExtractor } from "../../src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.js";

const CAPABILITIES = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: false,
  supportsThinking: false,
  supportsJsonSchema: true,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 1_000_000,
  maxOutputTokens: 65_536,
};

function request(provider: string, model = "test-model"): CanonicalModelRequest {
  return {
    provider,
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    stream: false,
  };
}

function config(protocol: "openai" | "anthropic" | "google", url = "https://example.test/llm"): ModelConfig {
  return {
    providers: {
      test: {
        id: "test",
        protocol,
        url,
        apiKey: "test-key",
        headers: {},
        models: {
          "test-model": {
            id: "test-model",
            capabilities: CAPABILITIES,
            multimodal: { input: ["text"] },
            aliases: [],
          },
        },
      },
    },
  };
}

test("OpenAI chat completions uses /v1/chat/completions and max_tokens 65536", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  await complete(request("test"), config("openai"), {
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    },
  });
  assert.equal(calls[0]?.url, "https://example.test/llm/v1/chat/completions");
  assert.equal(calls[0]?.body.max_tokens, 65_536);
});

test("Anthropic messages uses /v1/messages and max_tokens 65536", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  await complete(request("test"), config("anthropic"), {
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    },
  });
  assert.equal(calls[0]?.url, "https://example.test/llm/v1/messages");
  assert.equal(calls[0]?.body.max_tokens, 65_536);
});

test("Gemini native request sets generationConfig.maxOutputTokens 65536", () => {
  const body = buildModelRequest(request("test"), config("google")) as any;
  assert.equal(body.config.maxOutputTokens, 65_536);
  assert.equal(body.model, "test-model");
});

test("output-cap provider errors recover by adjusting output only", () => {
  const error = normalizeModelError(
    "test",
    "openai",
    { error: { message: "Range of max_tokens should be [1, 32768]" } },
    400,
  );
  const decision = new ContextOverflowRecovery().decide({ error, hasAttemptedCompact: false });
  assert.deepEqual(decision, { type: "adjust_output_and_retry", maxOutputTokens: 32_768, reason: "provider-output-cap", scope: "hard_cap" });
});

test("Anthropic available_tokens errors recover by lowering output", () => {
  const error = normalizeModelError(
    "test",
    "anthropic",
    { error: { message: "max_tokens: 65536 > context_window: 200000 - input_tokens: 190000 = available_tokens: 10000" } },
    400,
  );
  const decision = new ContextOverflowRecovery().decide({ error, hasAttemptedCompact: false });
  assert.deepEqual(decision, { type: "adjust_output_and_retry", maxOutputTokens: 10_000, reason: "provider-output-cap", scope: "attempt" });
});

test("context-cap provider errors request compaction", () => {
  const error = normalizeModelError(
    "test",
    "google",
    { error: { message: "Input exceeds the max_model_len of 262144 tokens." } },
    400,
  );
  const decision = new ContextOverflowRecovery().decide({ error, hasAttemptedCompact: false });
  assert.deepEqual(decision, { type: "compact_and_retry", maxContextTokens: 262_144, reason: "provider-context-cap" });
});

test("unknown provider errors keep existing fallback path", () => {
  const error = normalizeModelError("test", "openai", { error: { message: "provider said nope" } }, 400);
  const decision = new ContextOverflowRecovery().decide({ error, hasAttemptedCompact: false });
  assert.equal(decision.type, "give_up");
});

test("OpenAI Responses memory path posts to /responses and extracts text", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ output_text: "ok" });
  }) as typeof fetch;
  try {
    const extractor = new LlmMemoryExtractor({
      agent: { model: "test/test-model" },
      models: {
        providers: {
          test: { api: "responses", baseUrl: "https://example.test/llm", apiKey: "test-key", models: [{ id: "test-model" }] },
        },
      },
    }, undefined);
    const text = await (extractor as any).callStructuredJson({
      systemPrompt: "Return JSON.",
      userPrompt: "{}",
      requestLabel: "responses-test",
    });
    assert.equal(text, "ok");
    assert.equal(calls[0]?.url, "https://example.test/llm/responses");
    assert.equal(calls[0]?.body.model, "test-model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
