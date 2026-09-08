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
  assert.equal((requestedBody?.tools as Array<Record<string, unknown>>)[0]?.strict, true);
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
