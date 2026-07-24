import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_BASE_URL,
  CODEX_MODELS_URL,
} from "../../src/model/providers/codex/constants.js";
import {
  buildCodexRequestHeaders,
  fetchCodexModels,
} from "../../src/model/providers/codex/client.js";
import { buildOpenAIResponsesRequest } from "../../src/model/providers/openai-responses/request.js";
import {
  buildProviderChatEndpointCandidates,
  buildProviderModelsEndpointCandidates,
} from "../../src/model/providerEndpoint.js";
import { complete } from "../../src/model/streaming/streamModel.js";
import type {
  CanonicalModelRequest,
  ModelConfig,
  ModelDefinition,
  ProviderConfig,
} from "../../src/model/protocol/canonical.js";

test("uses the subscription-only Codex endpoints without inserting /v1", () => {
  assert.deepEqual(buildProviderChatEndpointCandidates({
    protocol: "openai-responses",
    baseUrl: CODEX_BASE_URL,
  }), [`${CODEX_BASE_URL}/responses`]);
  assert.deepEqual(buildProviderModelsEndpointCandidates({
    protocol: "openai-responses",
    baseUrl: CODEX_BASE_URL,
  }), [`${CODEX_BASE_URL}/models`]);
});

test("extracts the account claim and requests the live Codex model catalog", async () => {
  const accessToken = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_catalog" },
  });
  const headers = buildCodexRequestHeaders(accessToken);
  assert.equal(headers.authorization, `Bearer ${accessToken}`);
  assert.equal(headers["ChatGPT-Account-Id"], "acct_catalog");

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const models = await fetchCodexModels({
    credentials: {
      accessToken,
      accountId: "acct_catalog",
      source: "device-code",
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        models: [
          { slug: "gpt-later", display_name: "GPT Later", priority: 20 },
          { slug: "gpt-hidden", visibility: "hide", priority: 0 },
          {
            slug: "gpt-first",
            display_name: "GPT First",
            priority: 1,
            supported_in_api: false,
            context_window: 200_000,
            max_output_tokens: 50_000,
          },
        ],
      });
    }) as typeof fetch,
  });

  assert.equal(calls[0].url, CODEX_MODELS_URL);
  const requestHeaders = new Headers(calls[0].init?.headers);
  assert.equal(requestHeaders.get("authorization"), `Bearer ${accessToken}`);
  assert.equal(requestHeaders.get("ChatGPT-Account-Id"), "acct_catalog");
  assert.deepEqual(models.map((model) => model.id), ["gpt-first", "gpt-later"]);
  assert.equal(models[0].contextWindow, 200_000);
  assert.equal(models[0].maxOutputTokens, 50_000);
});

test("adds the same forward-compatible subscription models as Hermes", async () => {
  const models = await fetchCodexModels({
    credentials: {
      accessToken: jwt({}),
      source: "device-code",
    },
    fetch: (async () => jsonResponse({
      models: [{ slug: "gpt-5.4", priority: 1 }],
    })) as typeof fetch,
  });

  assert.deepEqual(models.map((model) => model.id), [
    "gpt-5.4",
    "gpt-5.6-sol",
    "gpt-5.6-sol-pro",
    "gpt-5.6-terra",
    "gpt-5.6-terra-pro",
    "gpt-5.6-luna",
    "gpt-5.6-luna-pro",
    "gpt-5.5",
  ]);
});

test("sends Codex responses as a stream and refreshes once after HTTP 401", async () => {
  const firstToken = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_old" },
  });
  const refreshedToken = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_new" },
  });
  const resolverCalls: boolean[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const response = await complete(canonicalRequest(), modelConfig(), {
    codexCredentialResolver: async ({ forceRefresh = false } = {}) => {
      resolverCalls.push(forceRefresh);
      return {
        accessToken: forceRefresh ? refreshedToken : firstToken,
        accountId: forceRefresh ? "acct_new" : "acct_old",
        source: forceRefresh ? "refresh" : "device-code",
      };
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return jsonResponse({ error: "expired" }, 401);
      return new Response([
        sse({ type: "response.created", response: { id: "resp_1" } }),
        sse({ type: "response.output_text.delta", delta: "OK" }),
        sse({
          type: "response.completed",
          response: {
            id: "resp_1",
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          },
        }),
        "data: [DONE]\n\n",
      ].join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(resolverCalls, [false, true]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `${CODEX_BASE_URL}/responses`);
  const retryHeaders = new Headers(requests[1].init?.headers);
  assert.equal(retryHeaders.get("authorization"), `Bearer ${refreshedToken}`);
  assert.equal(retryHeaders.get("ChatGPT-Account-Id"), "acct_new");
  assert.equal(retryHeaders.get("originator"), "codex_cli_rs");
  const body = JSON.parse(String(requests[1].init?.body));
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.instructions, "You are a helpful coding agent.");
  assert.equal(body.metadata, undefined);
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(response.content, [{ type: "text", text: "OK" }]);
  assert.equal(response.finishReason, "stop");
  assert.deepEqual({
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    totalTokens: response.usage?.totalTokens,
  }, {
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
  });
});

test("builds Codex request invariants even without a system prompt", () => {
  const { provider, model } = codexFixtures();
  const body = buildOpenAIResponsesRequest({
    ...canonicalRequest(),
    thinking: undefined,
  }, model, provider);

  assert.equal(body.instructions, "You are a helpful coding agent.");
  assert.equal(body.store, false);
  assert.equal(body.metadata, undefined);
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
});

test("keeps optional Codex tool properties non-strict like Hermes", () => {
  const { provider, model } = codexFixtures();
  const body = buildOpenAIResponsesRequest({
    ...canonicalRequest(),
    tools: [{
      name: "agent",
      inputSchema: {
        type: "object",
        required: ["description", "prompt"],
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          prompt: { type: "string" },
          subagent_type: { type: "string" },
        },
      },
    }],
  }, model, provider);

  assert.equal(body.tools?.[0]?.strict, false);
  assert.deepEqual(body.tools?.[0]?.parameters.required, ["description", "prompt"]);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.parallel_tool_calls, true);
});

test("uses role-correct text parts when replaying Codex conversation history", () => {
  const { provider, model } = codexFixtures();
  const body = buildOpenAIResponsesRequest({
    ...canonicalRequest(),
    messages: [
      { role: "user", content: [{ type: "text", text: "Who are you?" }] },
      { role: "assistant", content: [{ type: "text", text: "I am PilotDeck." }] },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ],
  }, model, provider);

  assert.deepEqual(
    body.input.map((item) => "content" in item ? item.content[0]?.type : item.type),
    ["input_text", "output_text", "input_text"],
  );
});

function canonicalRequest(): CanonicalModelRequest {
  return {
    provider: "codex",
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: [{ type: "text", text: "Reply OK." }] }],
    metadata: { trace: "must-not-leak" },
    thinking: { enabled: true, mode: "high" },
    maxOutputTokens: 32,
    temperature: 0.4,
  };
}

function modelConfig(): ModelConfig {
  const { provider } = codexFixtures();
  return { providers: { codex: provider } };
}

function codexFixtures(): { provider: ProviderConfig; model: ModelDefinition } {
  const model: ModelDefinition = {
    id: "gpt-5.6-sol",
    capabilities: {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking: true,
      supportsJsonSchema: true,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 272_000,
      maxOutputTokens: 128_000,
    },
    multimodal: { input: ["text", "image"] },
  };
  return {
    model,
    provider: {
      id: "codex",
      protocol: "openai-responses",
      url: CODEX_BASE_URL,
      apiKey: "",
      headers: {},
      models: { [model.id]: model },
    },
  };
}

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
