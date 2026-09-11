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

function message(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function promptDate(context: { systemPrompt?: string }): string | undefined {
  return context.systemPrompt?.match(/now: (\d{4}-\d{2}-\d{2})/)?.[1];
}

test("session prompt date survives midnight, retries, and normal appends", async () => {
  let now = new Date("2026-09-10T23:59:59Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  const first = await runtime.prepareForModel(input());
  now = new Date("2026-09-11T00:01:00Z");
  const retry = await runtime.prepareForModel(input());
  assert.equal(retry.systemPrompt, first.systemPrompt);
  assert.deepEqual(retry.cachePlan, first.cachePlan);
  const next = await runtime.prepareForModel(input({
    turnId: "next-turn",
    messages: [...input().messages, message("next request")],
  }));
  assert.equal(next.systemPrompt, first.systemPrompt);
  const other = await runtime.prepareForModel(input({ sessionId: "other-session" }));
  assert.equal(promptDate(other), "2026-09-11");
});

test("date refreshes after history rewrites, then freezes again", async () => {
  for (const rewritten of [
    [message("tail")], // Head truncation / overflow recovery.
    [message("summary"), message("tail")], // Full compaction.
    [message("head"), message("short tool result"), message("tail")], // Micro compaction.
    [message("head"), message("tail")], // Middle snip with stable head.
  ]) {
    let now = new Date("2026-09-10T12:00:00Z");
    const runtime = new DefaultContextRuntime({ now: () => now });
    await runtime.prepareForModel(input({ messages: [message("head"), message("long tool result"), message("tail")] }));
    now = new Date("2026-09-11T12:00:00Z");
    const compacted = await runtime.prepareForModel(input({ messages: rewritten }));
    assert.equal(promptDate(compacted), "2026-09-11");
    now = new Date("2026-09-12T12:00:00Z");
    const next = await runtime.prepareForModel(input({ messages: [...rewritten, message("next")] }));
    assert.equal(promptDate(next), "2026-09-11");
  }
});

test("sliding window refreshes only when the projected history actually changes", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  const messages = [message("old"), message("head"), message("tail")];
  await runtime.prepareForModel(input({ messages, maxMessages: 2 }));
  now = new Date("2026-09-11T12:00:00Z");
  const retry = await runtime.prepareForModel(input({ messages, maxMessages: 2 }));
  assert.equal(promptDate(retry), "2026-09-10");
  const advanced = await runtime.prepareForModel(input({ messages: [...messages, message("next")], maxMessages: 2 }));
  assert.equal(promptDate(advanced), "2026-09-11");
});

test("discarded budget candidates do not change the live date or cache generation", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  const first = await runtime.prepareForModel(input());
  now = new Date("2026-09-11T12:00:00Z");
  const candidate = await runtime.prepareForModel(input({ previewOnly: true, messages: [message("hypothetical summary")] }));
  assert.equal(promptDate(candidate), "2026-09-10");
  const unchanged = await runtime.prepareForModel(input());
  assert.equal(unchanged.systemPrompt, first.systemPrompt);
  assert.deepEqual(unchanged.cachePlan, first.cachePlan);
  const committed = await runtime.prepareForModel(input({ messages: candidate.messages }));
  assert.equal(promptDate(committed), "2026-09-11");
});

test("date anchoring also applies to providers without an explicit cache plan", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  const first = await runtime.prepareForModel(input({ protocol: "openai" }));
  now = new Date("2026-09-11T12:00:00Z");
  const next = await runtime.prepareForModel(input({ protocol: "openai" }));
  assert.equal(next.systemPrompt, first.systemPrompt);
  assert.equal(next.cachePlan, undefined);
});
