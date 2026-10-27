import test from "node:test";
import assert from "node:assert/strict";

import {
  actualInputTokensFromUsage,
  TokenAccountingRuntime,
  TokenBudgetManager,
  type TokenCalibrationBaseline,
} from "../../src/context/index.js";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
} from "../../src/model/index.js";
import { normalizeGoogleUsage } from "../../src/model/providers/google/response.js";

class FixedTokenBudget extends TokenBudgetManager {
  value = 1;

  override estimateMessagesTokens(_messages: CanonicalMessage[]): number {
    return this.value;
  }

  override estimateTextTokens(_text: string): number {
    return 0;
  }
}

test("current provider count wins even when it is below the local estimate", async () => {
  const tokenBudget = new FixedTokenBudget();
  tokenBudget.value = 50_000;
  const accounting = new TokenAccountingRuntime({
    modelConfig: modelConfig("anthropic", "https://api.anthropic.com"),
    tokenBudget,
    cacheSize: 0,
    fetch: (async () => new Response(JSON.stringify({ input_tokens: 12_345 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  const counted = await accounting.countRequestInput(request(), {
    calibration: baseline(55_000, 50_000),
  });

  assert.equal(counted.tokens, 12_345);
  assert.equal(counted.localEstimateTokens, 50_000);
  assert.equal(counted.source, "provider");
  assert.equal(counted.exact, true);
});

test("official OpenAI Responses routes use the provider input-token endpoint", async () => {
  const tokenBudget = new FixedTokenBudget();
  tokenBudget.value = 50_000;
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> | undefined;
  const accounting = new TokenAccountingRuntime({
    modelConfig: modelConfig("openai-responses", "https://api.openai.com/v1"),
    tokenBudget,
    cacheSize: 0,
    fetch: (async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ input_tokens: 12_345 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const counted = await accounting.countRequestInput({
    ...request(),
    systemPrompt: "Use the project conventions.",
    messages: [{
      role: "user",
      content: [{ type: "pdf", source: "base64", mimeType: "application/pdf", data: "ZmFrZQ==", bytes: 4 }],
    }],
    tools: [{
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
  });

  assert.equal(requestedUrl, "https://api.openai.com/v1/responses/input_tokens");
  assert.equal(counted.tokens, 12_345);
  assert.equal(counted.source, "provider");
  assert.equal(counted.exact, true);
  assert.equal(requestedBody?.instructions, "Use the project conventions.");
  const firstInput = (requestedBody?.input as Array<{ content: Array<{ type: string }> }> | undefined)?.[0];
  assert.equal(firstInput?.content[0]?.type, "input_file");
  // Function tools intentionally use non-strict schemas in the execution serializer.
  assert.equal((requestedBody?.tools as Array<Record<string, unknown>>)[0]?.strict, false);
  assert.equal(requestedBody?.stream, undefined);
  assert.equal(requestedBody?.max_output_tokens, undefined);
});

test("official OpenAI Chat Completions routes do not use the Responses count endpoint", async () => {
  const tokenBudget = new FixedTokenBudget();
  tokenBudget.value = 50_000;
  let fetchCalls = 0;
  const accounting = new TokenAccountingRuntime({
    modelConfig: modelConfig("openai", "https://api.openai.com/v1"),
    tokenBudget,
    cacheSize: 0,
    fetch: (async () => {
      fetchCalls += 1;
      throw new Error("Chat Completions must not call the Responses count endpoint.");
    }) as typeof fetch,
  });

  const counted = await accounting.countRequestInput(request(), {
    calibration: baseline(55_000, 50_000),
  });

  assert.equal(fetchCalls, 0);
  assert.equal(counted.tokens, 55_000);
  assert.equal(counted.source, "calibrated");
  assert.equal(counted.exact, false);
});

test("an OpenAI-compatible route uses the previous real-usage delta for calibration", async () => {
  const tokenBudget = new FixedTokenBudget();
  const accounting = new TokenAccountingRuntime({
    modelConfig: modelConfig("openai", "http://127.0.0.1:8000/v1"),
    tokenBudget,
  });
  const calibration = baseline(55_000, 50_000);

  tokenBudget.value = 62_000;
  const grown = await accounting.evaluateRequestBudget(request(), {
    maxContextTokens: 128_000,
    reservedOutputTokens: 32_768,
    calibration,
  });
  assert.equal(grown.tokens, 67_000);
  assert.equal(grown.displayTokens, undefined);
  assert.equal(grown.localEstimateTokens, 62_000);
  assert.equal(grown.source, "calibrated");
  assert.equal(grown.calibrationActualInputTokens, 55_000);
  assert.equal(grown.calibrationEstimatedInputTokens, 50_000);

  tokenBudget.value = 30_000;
  const compacted = await accounting.countRequestInput(request(), { calibration });
  assert.equal(compacted.tokens, 35_000);
  assert.equal(compacted.source, "calibrated");
});

test("calibration correction cannot collapse a compacted request below half its local estimate", async () => {
  const tokenBudget = new FixedTokenBudget();
  const accounting = new TokenAccountingRuntime({
    modelConfig: modelConfig("openai", "http://127.0.0.1:8000/v1"),
    tokenBudget,
  });
  tokenBudget.value = 8_000;

  const counted = await accounting.countRequestInput(request(), {
    calibration: baseline(50_000, 60_000),
  });

  assert.equal(counted.tokens, 4_000);
  assert.equal(counted.source, "calibrated");
});

test("failed or unavailable provider counting falls back to matching calibration, then local", async () => {
  const tokenBudget = new FixedTokenBudget();
  tokenBudget.value = 20_000;
  const accounting = new TokenAccountingRuntime({
    modelConfig: modelConfig("anthropic", "https://api.anthropic.com"),
    tokenBudget,
    cacheSize: 0,
    fetch: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
  });

  const calibrated = await accounting.countRequestInput(request(), {
    calibration: baseline(22_000, 19_000),
  });
  assert.equal(calibrated.tokens, 23_000);
  assert.equal(calibrated.source, "calibrated");
  assert.match(calibrated.estimatorError ?? "", /HTTP 503/);

  const local = await accounting.countRequestInput(request());
  assert.equal(local.tokens, 20_000);
  assert.equal(local.source, "local");

  const isolated = await accounting.countRequestInput(request(), {
    useProviderCount: false,
    calibration: { ...baseline(22_000, 19_000), model: "other-model" },
  });
  assert.equal(isolated.tokens, 20_000);
  assert.equal(isolated.source, "local");
});

test("real input usage includes cache traffic and excludes output tokens", () => {
  assert.equal(actualInputTokensFromUsage({
    inputTokens: 10_000,
    cacheReadTokens: 2_000,
    cacheWriteTokens: 500,
    outputTokens: 30_000,
  }), 12_500);
  assert.equal(actualInputTokensFromUsage({ outputTokens: 30_000 }), undefined);

  const googleUsage = normalizeGoogleUsage({
    promptTokenCount: 10_000,
    cachedContentTokenCount: 2_000,
    candidatesTokenCount: 500,
    totalTokenCount: 10_500,
  });
  assert.equal(actualInputTokensFromUsage(googleUsage), 10_000);
});

function baseline(actualInputTokens: number, estimatedInputTokens: number): TokenCalibrationBaseline {
  return {
    provider: "test-provider",
    model: "test-model",
    actualInputTokens,
    estimatedInputTokens,
  };
}

function request(): CanonicalModelRequest {
  return {
    provider: "test-provider",
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "test request" }] }],
    stream: true,
  };
}

function modelConfig(protocol: ModelProtocol, url: string): ModelConfig {
  const model: ModelDefinition = {
    id: "test-model",
    capabilities: {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: false,
      supportsThinking: false,
      supportsJsonSchema: false,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxOutputTokens: 32_768,
      maxContextTokens: 128_000,
    },
    multimodal: { input: ["text"] },
  };
  return {
    providers: {
      "test-provider": {
        id: "test-provider",
        protocol,
        url,
        apiKey: "test-key",
        headers: {},
        models: { "test-model": model },
      },
    },
  };
}

test("iteration-local estimates reuse unchanged input but invalidate every counted component", () => {
  class CountingBudget extends TokenBudgetManager {
    passes = 0;
    override estimateMessagesTokens(messages: CanonicalMessage[]): number {
      this.passes++;
      return super.estimateMessagesTokens(messages);
    }
  }
  const tokenBudget = new CountingBudget();
  const accounting = new TokenAccountingRuntime({ modelConfig: { providers: {} }, tokenBudget });
  const cache = new Map<string, number>();
  const original = { ...request(), systemPrompt: "system", tools: [{ name: "inspect", inputSchema: { type: "object" } }] };
  const initial = accounting.estimateRequestInput(original, cache);
  assert.equal(accounting.estimateRequestInput(structuredClone(original), cache), initial);
  assert.equal(accounting.estimateRequestInput({ ...original, provider: "other", model: "other", maxOutputTokens: 100 }, cache), initial);
  assert.equal(tokenBudget.passes, 1);
  for (const changed of [
    { ...original, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "new history" }] }] },
    { ...original, systemPrompt: "new instructions" },
    { ...original, tools: [{ name: "inspect", inputSchema: { type: "object", properties: { path: { type: "string" } } } }] },
    { ...original, messages: [{ role: "user" as const, content: [{ type: "image" as const, source: "base64" as const, data: "AA==", mimeType: "image/png" }] }] },
  ]) {
    const expected = accounting.estimateRequestInput(changed);
    const before: number = tokenBudget.passes;
    assert.equal(accounting.estimateRequestInput(changed, cache), expected);
    assert.equal(tokenBudget.passes, before + 1);
    assert.equal(accounting.estimateRequestInput(structuredClone(changed), cache), expected);
    assert.equal(tokenBudget.passes, before + 1);
  }
  const before = tokenBudget.passes;
  accounting.estimateRequestInput(original, new Map());
  assert.equal(tokenBudget.passes, before + 1, "a new iteration starts with an empty estimate scope");
});

test("local reuse preserves provider counts and route-specific calibration", async () => {
  let estimates = 0, providerCalls = 0;
  class CountingBudget extends FixedTokenBudget {
    override estimateMessagesTokens(messages: CanonicalMessage[]): number {
      estimates++;
      return super.estimateMessagesTokens(messages);
    }
  }
  const tokenBudget = new CountingBudget();
  tokenBudget.value = 20_000;
  const config = modelConfig("anthropic", "https://api.anthropic.com");
  config.providers["test-provider"].models["other-model"] = {
    ...config.providers["test-provider"].models["test-model"], id: "other-model",
  };
  const accounting = new TokenAccountingRuntime({ modelConfig: config, tokenBudget, cacheSize: 0,
    fetch: async () => new Response(JSON.stringify({ input_tokens: 1000 + ++providerCalls }), { status: 200 }),
  });
  const localEstimates = new Map<string, number>();
  assert.equal((await accounting.countRequestInput(request(), { localEstimates })).tokens, 1001);
  assert.equal((await accounting.countRequestInput({ ...request(), model: "other-model" }, { localEstimates })).tokens, 1002);
  assert.equal(providerCalls, 2, "local estimates never substitute for provider counts");
  const first = await accounting.evaluateRequestBudget(request(), { localEstimates, useProviderCount: false,
    maxContextTokens: 100_000, reservedOutputTokens: 1000, calibration: baseline(22_000, 20_000) });
  const second = await accounting.evaluateRequestBudget(request(), { localEstimates, useProviderCount: false,
    maxContextTokens: 50_000, reservedOutputTokens: 5000, calibration: baseline(23_000, 20_000) });
  assert.equal(first.tokens, 22_000);
  assert.equal(second.tokens, 23_000);
  assert.equal(second.reservedOutputTokens, 5000);
  assert.equal(second.maxContextTokens, 45_000);
  const otherRoute = await accounting.countRequestInput({ ...request(), model: "other-model" }, {
    localEstimates, useProviderCount: false, calibration: baseline(23_000, 20_000),
  });
  assert.equal(otherRoute.tokens, 20_000);
  assert.equal(otherRoute.source, "local", "a calibration from another model must not be reused");
  assert.equal(estimates, 1);
});
