import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelDefinition } from "../../../src/model/index.js";
import { buildAnthropicRequest } from "../../../src/model/providers/anthropic/request.js";

const model: ModelDefinition = {
  id: "claude-test",
  capabilities: {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: false,
    supportsThinking: false,
    supportsJsonSchema: false,
    supportsSystemPrompt: true,
    supportsPromptCache: true,
    maxContextTokens: 8192,
    maxOutputTokens: 1024,
  },
  multimodal: { input: ["text"] },
};

function request(overrides: Partial<CanonicalModelRequest> = {}): CanonicalModelRequest {
  return {
    provider: "modelbest",
    model: model.id,
    systemPrompt: "stable system",
    messages: Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: [{ type: "text" as const, text: `message-${index}` }],
    })),
    maxOutputTokens: 128,
    ...overrides,
  };
}

function markedMessageIndexes(body: ReturnType<typeof buildAnthropicRequest>): number[] {
  return body.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.content.some((block) => (
      typeof block === "object" && block !== null &&
      (block as { cache_control?: { type?: string } }).cache_control?.type === "ephemeral"
    )))
    .map(({ index }) => index);
}

test("Anthropic request emits system plus recent3 with a five-minute TTL", () => {
  const body = buildAnthropicRequest(request({
    cachePlan: {
      provider: "modelbest",
      model: model.id,
      system: true,
      tools: false,
      messages: [2, 3, 4],
      fingerprint: "fixture",
      generation: 1,
    },
  }), model);

  assert.deepEqual(markedMessageIndexes(body), [2, 3, 4]);
  assert.deepEqual(body.system, [{
    type: "text",
    text: "stable system",
    cache_control: { type: "ephemeral", ttl: "5m" },
  }]);
  for (const message of body.messages) {
    for (const block of message.content) {
      const cacheControl = typeof block === "object" && block !== null
        ? (block as { cache_control?: { ttl?: string } }).cache_control
        : undefined;
      if (cacheControl) assert.equal(cacheControl.ttl, "5m");
    }
  }
  assert.equal(1 + markedMessageIndexes(body).length, 4);
  assert.equal(body.tools, undefined);
});

test("explicit tools marker remains compatible and consumes one message slot", () => {
  const body = buildAnthropicRequest(request({
    tools: [
      { name: "z_tool", description: "z", inputSchema: { type: "object" } },
      { name: "a_tool", description: "a", inputSchema: { type: "object" } },
    ],
    cachePlan: {
      system: true,
      tools: true,
      messages: [0, 1, 2, 3],
      fingerprint: "fixture",
      generation: 1,
    },
  }), model);

  assert.deepEqual(body.tools?.map((tool) => tool.name), ["z_tool", "a_tool"]);
  assert.deepEqual(body.tools?.map((tool) => tool.cache_control?.ttl), [undefined, "5m"]);
  assert.deepEqual(markedMessageIndexes(body), [2, 3]);
});

test("cache plan can disable system and tools markers explicitly", () => {
  const body = buildAnthropicRequest(request({
    cachePlan: {
      system: false,
      tools: false,
      messages: [],
      fingerprint: "disabled",
      generation: 1,
    },
  }), model);

  assert.equal(body.system, "stable system");
  assert.deepEqual(markedMessageIndexes(body), []);
});

test("Anthropic skips a cache marker for a thinking-only recent message", () => {
  const body = buildAnthropicRequest(request({
    messages: [
      { role: "user", content: [{ type: "text", text: "request" }] },
      { role: "assistant", content: [{ type: "thinking", text: "unfinished reasoning" }] },
    ],
    cachePlan: {
      system: true,
      tools: false,
      messages: [1],
      fingerprint: "thinking-only",
      generation: 1,
    },
  }), model);

  const thinking = body.messages[1]?.content[0] as { type?: string; cache_control?: unknown };
  assert.equal(thinking.type, "thinking");
  assert.equal(thinking.cache_control, undefined);
});

test("Anthropic anchors before a trailing thinking block", () => {
  const body = buildAnthropicRequest(request({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "partial answer" },
          { type: "thinking", text: "unfinished reasoning" },
        ],
      },
    ],
    cachePlan: {
      system: true,
      tools: false,
      messages: [0],
      fingerprint: "text-before-thinking",
      generation: 1,
    },
  }), model);

  const content = body.messages[0]?.content as Array<{ type?: string; cache_control?: { ttl?: string } }>;
  assert.equal(content[0]?.cache_control?.ttl, "5m");
  assert.equal(content[1]?.cache_control, undefined);
});
