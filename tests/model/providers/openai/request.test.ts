import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenAIRequest } from "../../../../src/model/providers/openai/request.js";
import type {
  CanonicalModelRequest,
  CanonicalToolSchema,
  ModelDefinition,
} from "../../../../src/model/protocol/canonical.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../../../src/model/protocol/multimodal.js";

const TEST_MODEL: ModelDefinition = {
  id: "openai/test",
  capabilities: {
    ...DEFAULT_MODEL_CAPABILITIES,
    maxOutputTokens: 1024,
  },
  multimodal: DEFAULT_MULTIMODAL_CONSTRAINTS,
};

function createRequest(tools: CanonicalToolSchema[]): CanonicalModelRequest {
  return {
    model: "openai/test",
    provider: "openai",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools,
  };
}

test("buildOpenAIRequest normalizes array-union tool schema nodes missing items", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      value: {
        type: ["object", "array", "string", "number", "boolean"],
      },
      status: {
        type: ["string", "array"],
      },
      nested: {
        oneOf: [
          { type: ["array", "null"] },
          {
            type: "object",
            properties: {
              tags: { type: ["string", "array"] },
            },
          },
        ],
      },
    },
  } as Record<string, unknown>;

  const request = createRequest([{ name: "task_like_tool", inputSchema: schema }]);
  const body = buildOpenAIRequest(request, TEST_MODEL);
  const params = body.tools?.[0]?.function.parameters as Record<string, unknown>;
  const properties = params.properties as Record<string, unknown>;

  assert.deepEqual((properties.value as Record<string, unknown>).items, {});
  assert.deepEqual((properties.status as Record<string, unknown>).items, {});

  const nested = properties.nested as Record<string, unknown>;
  const oneOf = nested.oneOf as Array<Record<string, unknown>>;
  assert.deepEqual(oneOf[0].items, {});

  const nestedProps = (oneOf[1].properties as Record<string, unknown>);
  assert.deepEqual((nestedProps.tags as Record<string, unknown>).items, {});
});

test("buildOpenAIRequest preserves existing items and does not mutate original schema", () => {
  const schema = {
    type: "object",
    properties: {
      ids: {
        type: ["array", "string"],
      },
      labels: {
        type: "array",
        items: { type: "string" },
      },
    },
  } as Record<string, unknown>;

  const request = createRequest([{ name: "mixed_tool", inputSchema: schema }]);
  const body = buildOpenAIRequest(request, TEST_MODEL);
  const params = body.tools?.[0]?.function.parameters as Record<string, unknown>;
  const properties = params.properties as Record<string, unknown>;

  assert.deepEqual((properties.ids as Record<string, unknown>).items, {});
  assert.deepEqual((properties.labels as Record<string, unknown>).items, { type: "string" });

  const originalProps = schema.properties as Record<string, unknown>;
  assert.equal((originalProps.ids as Record<string, unknown>).items, undefined);
  assert.deepEqual((originalProps.labels as Record<string, unknown>).items, { type: "string" });
});

test("buildOpenAIRequest assigns valid ids and pairs empty tool results", () => {
  const request = createRequest([]);
  request.messages = [
    { role: "user", content: [{ type: "text", text: "run a tool" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "", name: "read_file", input: { file_path: "package.json" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "", content: [{ type: "text", text: "ok" }] }],
    },
  ];

  const body = buildOpenAIRequest(request, TEST_MODEL);
  const assistant = body.messages.find((message) => message.role === "assistant") as {
    tool_calls: Array<{ id: string; type: string }>;
  };
  const tool = body.messages.find((message) => message.role === "tool") as { tool_call_id: string };

  assert.equal(assistant.tool_calls[0].type, "function");
  assert.match(assistant.tool_calls[0].id, /^call_/);
  assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
});

test("buildOpenAIRequest moves delayed matching tool results directly after assistant tool calls", () => {
  const request = createRequest([]);
  request.messages = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "call_a", name: "grep", input: { pattern: "x" } }],
    },
    { role: "user", content: [{ type: "text", text: "new user message while tool was pending" }] },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call_a", content: [{ type: "text", text: "grep result" }] }],
    },
  ];

  const body = buildOpenAIRequest(request, TEST_MODEL);
  const roles = body.messages.map((message) => message.role);
  const assistantIndex = roles.indexOf("assistant");

  assert.equal(roles[assistantIndex + 1], "tool");
  assert.equal((body.messages[assistantIndex + 1] as { tool_call_id: string }).tool_call_id, "call_a");
  assert.equal(roles[assistantIndex + 2], "user");
});

test("buildOpenAIRequest drops orphan tool results without preceding assistant tool calls", () => {
  const request = createRequest([]);
  request.messages = [
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "orphan", content: [{ type: "text", text: "orphan result" }] }],
    },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ];

  const body = buildOpenAIRequest(request, TEST_MODEL);

  assert.equal(body.messages.some((message) => message.role === "tool"), false);
  assert.deepEqual(body.messages.map((message) => message.role), ["user"]);
});

test("buildOpenAIRequest injects missing tool results for multi-tool assistant messages", () => {
  const request = createRequest([]);
  request.messages = [
    { role: "user", content: [{ type: "text", text: "run two tools" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call_a", name: "read_file", input: { file_path: "a" } },
        { type: "tool_call", id: "call_b", name: "read_file", input: { file_path: "b" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call_b", content: [{ type: "text", text: "b-result" }] }],
    },
  ];

  const body = buildOpenAIRequest(request, TEST_MODEL);
  const toolMessages = body.messages.filter((message) => message.role === "tool") as Array<{
    tool_call_id: string;
    content: string;
  }>;

  assert.deepEqual(toolMessages.map((message) => message.tool_call_id), ["call_a", "call_b"]);
  assert.equal(toolMessages[0].content, "[result truncated]");
  assert.equal(toolMessages[1].content, "b-result");
});

test("buildOpenAIRequest keeps repeated multi-turn fallback tool ids unique", () => {
  const request = createRequest([]);
  request.messages = [
    { role: "user", content: [{ type: "text", text: "first round" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "call_0", name: "read_file", input: { file_path: "a" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call_0", content: [{ type: "text", text: "a-result" }] }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "call_0", name: "read_file", input: { file_path: "b" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call_0", content: [{ type: "text", text: "b-result" }] }],
    },
  ];

  const body = buildOpenAIRequest(request, TEST_MODEL);
  const assistantMessages = body.messages.filter((message) => message.role === "assistant") as Array<{
    tool_calls: Array<{ id: string }>;
  }>;
  const toolMessages = body.messages.filter((message) => message.role === "tool") as Array<{
    tool_call_id: string;
    content: string;
  }>;
  const ids = assistantMessages.map((message) => message.tool_calls[0].id);

  assert.equal(ids[0], "call_0");
  assert.notEqual(ids[1], "call_0");
  assert.deepEqual(toolMessages.map((message) => message.tool_call_id), ids);
  assert.deepEqual(toolMessages.map((message) => message.content), ["a-result", "b-result"]);
});

test("buildOpenAIRequest remaps duplicate ids within one assistant tool round", () => {
  const request = createRequest([]);
  request.messages = [
    { role: "user", content: [{ type: "text", text: "run duplicate ids" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "dup", name: "first", input: {} },
        { type: "tool_call", id: "dup", name: "second", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "dup", content: [{ type: "text", text: "first-result" }] },
        { type: "tool_result", toolCallId: "dup", content: [{ type: "text", text: "second-result" }] },
      ],
    },
  ];

  const body = buildOpenAIRequest(request, TEST_MODEL);
  const assistant = body.messages.find((message) => message.role === "assistant") as {
    tool_calls: Array<{ id: string }>;
  };
  const toolMessages = body.messages.filter((message) => message.role === "tool") as Array<{
    tool_call_id: string;
    content: string;
  }>;

  assert.deepEqual(assistant.tool_calls.map((call) => call.id), ["dup", "dup_1"]);
  assert.deepEqual(toolMessages.map((message) => message.tool_call_id), ["dup", "dup_1"]);
  assert.deepEqual(toolMessages.map((message) => message.content), ["first-result", "second-result"]);
});
