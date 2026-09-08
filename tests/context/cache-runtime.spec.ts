import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type { CanonicalMessage, CanonicalToolSchema } from "../../src/model/index.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";

const tool: CanonicalToolSchema = {
  name: "read_file",
  description: "read a file",
  inputSchema: { type: "object" },
};

function input(overrides: Partial<ContextPrepareInput> = {}): ContextPrepareInput {
  return {
    sessionId: "cache-session",
    turnId: "cache-turn",
    cwd: "/workspace",
    provider: "modelbest",
    model: "claude-test",
    protocol: "anthropic",
    supportsPromptCache: true,
    permissionMode: "default",
    runMode: "normal",
    additionalWorkingDirectories: [],
    messages: [{ role: "user", content: [{ type: "text", text: "request" }] }],
    tools: [tool],
    ...overrides,
  };
}

test("DefaultContextRuntime creates recent3 without a micro-compaction engine", async () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call-1", content: [{ type: "text", text: "two" }] }] },
    { role: "assistant", content: [{ type: "text", text: "three" }] },
    { role: "user", content: [{ type: "text", text: "four" }] },
  ];
  const result = await new DefaultContextRuntime().prepareForModel(input({ messages }));

  assert.deepEqual(result.cacheBreakpoints, [2, 3, 4]);
  assert.deepEqual(result.cachePlan?.messages, result.cacheBreakpoints);
  assert.equal(result.cachePlan?.tools, false);
});

test("recent3 follows the projected message list after truncation", async () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "old-1" }] },
    { role: "assistant", content: [{ type: "text", text: "old-2" }] },
    { role: "user", content: [{ type: "text", text: "new-1" }] },
    { role: "assistant", content: [{ type: "text", text: "new-2" }] },
    { role: "user", content: [{ type: "text", text: "new-3" }] },
  ];
  const result = await new DefaultContextRuntime().prepareForModel(input({ messages, maxMessages: 3 }));

  assert.deepEqual(result.messages.map((message) => message.content[0]), [
    { type: "text", text: "new-1" },
    { type: "text", text: "new-2" },
    { type: "text", text: "new-3" },
  ]);
  assert.deepEqual(result.cacheBreakpoints, [0, 1, 2]);
});

test("cache generation changes when the projected cache prefix changes", async () => {
  const runtime = new DefaultContextRuntime();
  const first = await runtime.prepareForModel(input({
    messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
  }));
  const second = await runtime.prepareForModel(input({
    messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
  }));

  assert.notEqual(first.cachePlan?.fingerprint, second.cachePlan?.fingerprint);
  assert.ok((second.cachePlan?.generation ?? 0) > (first.cachePlan?.generation ?? 0));
});

test("non-Anthropic and unsupported models do not receive a cache plan", async () => {
  const runtime = new DefaultContextRuntime();
  const openai = await runtime.prepareForModel(input({ protocol: "openai" }));
  const unsupported = await runtime.prepareForModel(input({ supportsPromptCache: false }));

  assert.equal(openai.cachePlan, undefined);
  assert.equal(openai.cacheBreakpoints, undefined);
  assert.equal(unsupported.cachePlan, undefined);
  assert.equal(unsupported.cacheBreakpoints, undefined);
});
