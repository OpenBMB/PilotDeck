import assert from "node:assert/strict";
import test from "node:test";

import { canonicalMessagesToMemoryMessages } from "../../src/context/memory/MemoryResolver.js";
import { CODEX_BASE_URL } from "../../src/model/providers/codex/constants.js";
import { buildOpenAIResponsesRequest } from "../../src/model/providers/openai-responses/request.js";
import { complete } from "../../src/model/streaming/streamModel.js";
import { parseOpenAIResponsesResponse } from "../../src/model/providers/openai-responses/response.js";
import {
  createOpenAIResponsesStreamState,
  normalizeOpenAIResponsesStreamEvent,
} from "../../src/model/providers/openai-responses/stream.js";
import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
} from "../../src/model/streaming/assembleModelMessage.js";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
  ModelDefinition,
  ProviderConfig,
} from "../../src/model/protocol/canonical.js";

const nativeHistory: CanonicalMessage = {
  role: "assistant",
  content: [
    {
      type: "thinking",
      text: "Checked the files.",
      responsesItemId: "rs_123",
      encryptedReasoningContent: "opaque-secret-payload",
    },
    {
      type: "tool_call",
      id: "call_123",
      name: "read_file",
      input: { path: "src/index.ts" },
      responsesItemId: "fc_123",
    },
  ],
};

const nativeToolResult: CanonicalMessage = {
  role: "user",
  content: [{
    type: "tool_result",
    toolCallId: "call_123",
    content: [{ type: "text", text: "file contents" }],
  }],
};

test("replays native Responses items only for strict Codex", () => {
  const { codex, openai, model } = fixtures();
  const request: CanonicalModelRequest = {
    provider: "codex",
    model: model.id,
    messages: [nativeHistory, nativeToolResult],
  };

  assert.deepEqual(buildOpenAIResponsesRequest(request, model, codex).include, [
    "reasoning.encrypted_content",
  ]);
  assert.deepEqual(buildOpenAIResponsesRequest(request, model, codex).input, [
    {
      type: "reasoning",
      id: "rs_123",
      encrypted_content: "opaque-secret-payload",
      summary: [{ type: "summary_text", text: "Checked the files." }],
    },
    {
      type: "function_call",
      id: "fc_123",
      call_id: "call_123",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/index.ts" }),
    },
    {
      type: "function_call_output",
      call_id: "call_123",
      output: "file contents",
    },
  ]);

  const ordinary = buildOpenAIResponsesRequest({ ...request, provider: openai.id }, model, openai);
  assert.equal(ordinary.include, undefined);
  assert.deepEqual(ordinary.input, [
    { role: "assistant", content: [{ type: "input_text", text: "Checked the files." }] },
    {
      type: "function_call",
      call_id: "call_123",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/index.ts" }),
    },
    {
      type: "function_call_output",
      call_id: "call_123",
      output: "file contents",
    },
  ]);
});

test("captures native item metadata from non-stream and stream responses", () => {
  const parsed = parseOpenAIResponsesResponse({
    id: "resp_1",
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_123",
        encrypted_content: "opaque-secret-payload",
        summary: [{ type: "summary_text", text: "Checked the files." }],
      },
      {
        type: "function_call",
        id: "fc_123",
        call_id: "call_123",
        name: "read_file",
        arguments: "{}",
      },
    ],
  }, "codex");
  assert.deepEqual(parsed.content.map(withoutRaw), [
    {
      type: "thinking",
      text: "Checked the files.",
      responsesItemId: "rs_123",
      encryptedReasoningContent: "opaque-secret-payload",
    },
    {
      type: "tool_call",
      id: "call_123",
      name: "read_file",
      input: {},
      responsesItemId: "fc_123",
    },
  ]);

  const streamState = createOpenAIResponsesStreamState();
  const assembler = createModelMessageAssemblerState();
  const rawEvents = [
    { type: "response.reasoning_summary_text.delta", delta: "Checked the files." },
    {
      type: "response.output_item.done",
      item: {
        type: "reasoning",
        id: "rs_123",
        encrypted_content: "opaque-secret-payload",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "fc_123", call_id: "call_123", name: "read_file" },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_123",
        call_id: "call_123",
        name: "read_file",
        arguments: "{}",
      },
    },
    { type: "response.completed", response: {} },
  ];
  for (const rawEvent of rawEvents) {
    for (const event of normalizeOpenAIResponsesStreamEvent(rawEvent, streamState)) {
      applyModelEventToAssembler(assembler, event);
    }
  }
  const streamed = assembleAssistantMessage(assembler);
  assert.deepEqual(
    streamed.message.content.map(withoutRaw),
    parsed.content.map(withoutRaw),
  );
});

test("public complete preserves replayable native reasoning metadata", async () => {
  const { codex, model } = fixtures();
  const response = await complete({
    provider: codex.id,
    model: model.id,
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect it." }] }],
  }, { providers: { [codex.id]: codex } }, {
    codexCredentialResolver: async () => ({
      accessToken: "e30.e30.signature",
      source: "device-code",
    }),
    fetch: (async () => new Response([
      sse({ type: "response.created", response: { id: "resp_1" } }),
      sse({ type: "response.reasoning_summary_text.delta", delta: "Checked the files." }),
      sse({
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          id: "rs_123",
          encrypted_content: "opaque-secret-payload",
        },
      }),
      sse({ type: "response.output_text.delta", delta: "Done." }),
      sse({
        type: "response.completed",
        response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
      }),
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
  });

  assert.deepEqual(response.content.map(withoutRaw), [
    {
      type: "thinking",
      text: "Checked the files.",
      responsesItemId: "rs_123",
      encryptedReasoningContent: "opaque-secret-payload",
    },
    { type: "text", text: "Done." },
  ]);
  assert.equal(response.finishReason, "stop");
  assert.deepEqual({
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    totalTokens: response.usage?.totalTokens,
  }, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });

  const replay = buildOpenAIResponsesRequest({
    provider: codex.id,
    model: model.id,
    messages: [{ role: "assistant", content: response.content }],
  }, model, codex);
  assert.deepEqual(replay.input[0], {
    type: "reasoning",
    id: "rs_123",
    encrypted_content: "opaque-secret-payload",
    summary: [{ type: "summary_text", text: "Checked the files." }],
  });
});

test("opaque native reasoning metadata stays out of visible memory", () => {
  assert.deepEqual(canonicalMessagesToMemoryMessages([nativeHistory]), []);
});

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function withoutRaw<T>(value: T): Omit<T, "raw"> {
  if (typeof value !== "object" || value === null) return value as Omit<T, "raw">;
  const { raw: _raw, ...rest } = value as T & { raw?: unknown };
  return rest;
}

function fixtures(): {
  codex: ProviderConfig;
  openai: ProviderConfig;
  model: ModelDefinition;
} {
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
    multimodal: { input: ["text"] },
  };
  const codex: ProviderConfig = {
    id: "codex",
    protocol: "openai-responses",
    url: CODEX_BASE_URL,
    apiKey: "",
    headers: {},
    models: { [model.id]: model },
  };
  return {
    model,
    codex,
    openai: { ...codex, id: "custom-openai", url: "https://api.example.com/v1" },
  };
}
