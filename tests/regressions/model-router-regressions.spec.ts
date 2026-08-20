import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnthropicRequest,
  cloneContentBlock,
  cloneMessages,
  type CanonicalMessage,
  type CanonicalModelEvent,
  type CanonicalModelRequest,
  type CanonicalModelResponse,
  type CanonicalToolCallBlock,
  type CanonicalToolResultBlock,
  type ModelDefinition,
  type ModelRuntime,
} from "../../src/model/index.js";
import { normalizeAnthropicStreamEvent } from "../../src/model/providers/anthropic/stream.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import type { RouterEvent } from "../../src/router/protocol/events.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";

test("cloning tool results isolates their nested content", () => {
  const original: CanonicalToolResultBlock = {
    type: "tool_result",
    toolCallId: "call-1",
    content: [{ type: "text", text: "before" }],
  };
  const cloned = cloneContentBlock(original) as CanonicalToolResultBlock;
  cloned.content.push({ type: "text", text: "after" });

  assert.equal(original.content.length, 1);
  assert.notEqual(cloned.content, original.content);
  assert.notEqual(cloned.content[0], original.content[0]);
});

test("cloning tool calls isolates nested input objects", () => {
  const messages: CanonicalMessage[] = [{
    role: "assistant",
    content: [{
      type: "tool_call",
      id: "call-1",
      name: "read_file",
      input: { path: "README.md", options: { offset: 1 } },
    }],
  }];
  const cloned = cloneMessages(messages);
  const clonedCall = cloned[0]?.content[0] as CanonicalToolCallBlock;
  (clonedCall.input as { options: { offset: number } }).options.offset = 99;

  const originalCall = messages[0]?.content[0] as CanonicalToolCallBlock;
  assert.equal((originalCall.input as { options: { offset: number } }).options.offset, 1);
});

test("Anthropic requests keep only the three newest message cache breakpoints", () => {
  const messages: CanonicalMessage[] = Array.from({ length: 5 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: [{ type: "text" as const, text: `message-${index}` }],
  }));
  const body = buildAnthropicRequest({
    provider: "anthropic",
    model: "claude",
    systemPrompt: "system",
    messages,
    cacheBreakpoints: [0, 1, 2, 3, 4],
  }, anthropicModel());
  const marked = body.messages
    .map((message, index) => ({ index, block: message.content.at(-1) as Record<string, unknown> }))
    .filter(({ block }) => block.cache_control !== undefined)
    .map(({ index }) => index);

  assert.deepEqual(marked, [2, 3, 4]);
  assert.deepEqual((body.system as Array<Record<string, unknown>>)[0]?.cache_control, { type: "ephemeral" });
});

test("Anthropic request metadata exposes only user_id", () => {
  const body = buildAnthropicRequest({
    provider: "anthropic",
    model: "claude",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    metadata: { user_id: "user-1", configSnapshotVersion: 42, script: "internal" },
  }, anthropicModel());

  assert.deepEqual(body.metadata, { user_id: "user-1" });
});

test("Anthropic tool results preserve image and PDF content", () => {
  const body = buildAnthropicRequest({
    provider: "anthropic",
    model: "claude",
    messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "call-1",
        content: [
          { type: "text", text: "preview" },
          { type: "image", source: "base64", mimeType: "image/png", data: "abc", bytes: 3 },
          { type: "pdf", source: "base64", mimeType: "application/pdf", data: "def", bytes: 3, pages: 1 },
        ],
      }],
    }],
  }, anthropicModel());
  const content = (body.messages[0]?.content[0] as { content: Array<{ type: string }> }).content;

  assert.deepEqual(content.map(block => block.type), ["text", "image", "document"]);
});

test("Anthropic stream marks transient provider errors retryable", () => {
  for (const code of ["overloaded_error", "rate_limit_error", "api_error", "timeout_error"]) {
    const [event] = normalizeAnthropicStreamEvent({
      type: "error",
      error: { type: code, message: "try again" },
    });
    assert.equal(event?.type, "error");
    assert.equal(event?.type === "error" ? event.error.retryable : false, true, code);
  }
  const [invalid] = normalizeAnthropicStreamEvent({
    type: "error",
    error: { type: "invalid_request_error", message: "bad input" },
  });
  assert.equal(invalid?.type === "error" ? invalid.error.retryable : true, false);
});

test("RouterRuntime forwards the turn abort signal to the model runtime", async () => {
  const model = new ScriptedModelRuntime([[
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    { type: "message_end", finishReason: "stop" },
  ]]);
  const router = createRouterRuntime(routerConfig(), { modelRuntime: model });
  const controller = new AbortController();

  await collect(router.stream(request(), {
    sessionId: "session-1",
    turnId: "turn-1",
    isMainAgent: true,
    abortSignal: controller.signal,
  }));

  assert.equal(model.signals[0], controller.signal);
});

test("RouterRuntime suppresses failed attempt events when fallback succeeds", async () => {
  const model = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      {
        type: "error",
        error: {
          provider: "primary",
          protocol: "anthropic",
          code: "overloaded_error",
          message: "busy",
          retryable: true,
        },
      },
    ],
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "fallback" },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const routerEvents: RouterEvent[] = [];
  const router = createRouterRuntime({
    ...routerConfig(),
    fallback: { default: [{ id: "secondary/model", provider: "secondary", model: "model" }] },
  }, {
    modelRuntime: model,
    events: { emit: event => routerEvents.push(event) },
  });

  const events = await collect(router.stream(request(), {
    sessionId: "session-1",
    turnId: "turn-1",
    isMainAgent: true,
  }));

  assert.deepEqual(model.requests.map(item => `${item.provider}/${item.model}`), ["primary/model", "secondary/model"]);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.some(event => event.type === "text_delta" && event.text === "fallback"), true);
  assert.equal(routerEvents.some(event => event.type === "pilotdeck_router_fallback"), true);
});

test("RouterRuntime retries a zero-usage empty completion without leaking it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const model = new ScriptedModelRuntime([
    [
      { type: "message_start", role: "assistant" },
      { type: "usage", usage: { totalTokens: 0 } },
      { type: "message_end", finishReason: "stop" },
    ],
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", text: "second attempt" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      { type: "message_end", finishReason: "stop" },
    ],
  ]);
  const router = createRouterRuntime(routerConfig(), { modelRuntime: model });

  const eventsPromise = collect(router.stream(request(), {
    sessionId: "session-1",
    turnId: "turn-1",
    isMainAgent: true,
  }));
  await immediate();
  t.mock.timers.tick(500);
  const events = await eventsPromise;

  assert.equal(model.requests.length, 2);
  assert.deepEqual(events.filter(event => event.type === "text_delta").map(event => event.text), ["second attempt"]);
});

function anthropicModel(): ModelDefinition {
  return {
    id: "claude",
    displayName: "Claude",
    capabilities: {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking: true,
      supportsJsonSchema: true,
      supportsSystemPrompt: true,
      supportsPromptCache: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 8_192,
    },
    multimodal: { input: ["text", "image", "pdf"] },
  };
}

function routerConfig(): RouterConfig {
  return {
    scenarios: { default: { id: "primary/model", provider: "primary", model: "model" } },
    zeroUsageRetry: { enabled: true, maxAttempts: 3 },
  };
}

function request(): CanonicalModelRequest {
  return {
    provider: "ignored",
    model: "ignored",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

class ScriptedModelRuntime implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];

  constructor(private readonly scripts: CanonicalModelEvent[][]) {}

  async *stream(requestValue: CanonicalModelRequest, options: { signal?: AbortSignal } = {}) {
    this.requests.push(requestValue);
    this.signals.push(options.signal);
    for (const event of this.scripts.shift() ?? []) yield event;
  }

  async complete(): Promise<CanonicalModelResponse> {
    throw new Error("not used");
  }

  getCapabilities() {
    return anthropicModel().capabilities;
  }

  getMultimodal() {
    return { input: ["text" as const] };
  }

  getProviderProtocol() {
    return "anthropic" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function immediate(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
