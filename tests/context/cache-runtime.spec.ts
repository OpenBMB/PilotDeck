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
  assert.equal(dateUpdates(retry).length, 1);
  assert.deepEqual(retry.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual((await runtime.prepareForModel(input())).cachePlan, retry.cachePlan);
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
  assert.equal(unchanged.cachePlan?.generation, (first.cachePlan?.generation ?? 0) + 1);
  assert.equal(dateUpdates(unchanged).length, 1);
  const committed = await runtime.prepareForModel(input({ messages: [message("hypothetical summary")] }));
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

function dateUpdates(context: { messages: CanonicalMessage[] }): CanonicalMessage[] {
  return context.messages.filter((entry) => entry.metadata?.purpose === "date_update");
}

test("rollovers append once per UTC day and preserve the previous request prefix", async () => {
  let now = new Date("2026-09-10T23:59:59Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  const messages = input().messages;
  const first = await runtime.prepareForModel(input({ messages }));
  assert.equal(dateUpdates(first).length, 0);
  now = new Date("2026-09-11T00:00:00Z");
  messages.push(message("today?"));
  const rollover = await runtime.prepareForModel(input({ messages }));
  assert.match(JSON.stringify(dateUpdates(rollover)), /current_date: 2026-09-11/);
  assert.equal(dateUpdates(rollover).length, 1);
  messages.push({ role: "assistant", content: [{ type: "text", text: "September 11" }] });
  messages.push(message("continue"));
  const next = await runtime.prepareForModel(input({ messages }));
  assert.equal(dateUpdates(next).length, 1);
  assert.deepEqual(next.messages.slice(0, rollover.messages.length), rollover.messages);
  now = new Date("2026-09-12T00:00:00Z");
  const tomorrow = await runtime.prepareForModel(input({ messages }));
  assert.equal(dateUpdates(tomorrow).length, 2);
  assert.deepEqual(tomorrow.messages.slice(0, next.messages.length), next.messages);
  assert.equal(tomorrow.systemPrompt, first.systemPrompt);
  assert.deepEqual(tomorrow.cacheBreakpoints, [tomorrow.messages.length - 3, tomorrow.messages.length - 2, tomorrow.messages.length - 1]);
  const other = await runtime.prepareForModel(input({ sessionId: "another" }));
  assert.equal(dateUpdates(other).length, 0);
  assert.equal(promptDate(other), "2026-09-12");
});

test("rollover previews neither consume the notice nor commit its position", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  await runtime.prepareForModel(input());
  now = new Date("2026-09-11T12:00:00Z");
  const preview = await runtime.prepareForModel(input({ previewOnly: true, messages: [...input().messages, message("discarded")] }));
  assert.equal(dateUpdates(preview).length, 1);
  const actual = await runtime.prepareForModel(input());
  assert.equal(actual.messages.length, 2);
  assert.equal(dateUpdates(actual).length, 1);
  const repeated = await runtime.prepareForModel(input());
  assert.deepEqual(repeated.messages, actual.messages);
  assert.deepEqual(repeated.cachePlan, actual.cachePlan);
});

test("rewrites retire rollover messages when the system date refreshes", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  await runtime.prepareForModel(input());
  now = new Date("2026-09-11T12:00:00Z");
  assert.equal(dateUpdates(await runtime.prepareForModel(input())).length, 1);
  const rewritten = await runtime.prepareForModel(input({ messages: [message("summary")] }));
  assert.equal(promptDate(rewritten), "2026-09-11");
  assert.equal(dateUpdates(rewritten).length, 0);
  const next = await runtime.prepareForModel(input({ messages: [message("summary"), message("continue")] }));
  assert.equal(dateUpdates(next).length, 0);
});

test("date notices preserve tool pairing and do not replace memory retrieval queries", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const queries: string[] = [];
  const runtime = new DefaultContextRuntime({
    now: () => now,
    memoryResolver: {
      async retrieve(request) {
        queries.push(request.query);
        assert.equal(dateUpdates({ messages: request.recentMessages }).length, 0);
        return { diagnostics: [] };
      },
      async captureTurn() {},
    },
  });
  await runtime.prepareForModel(input());
  now = new Date("2026-09-11T12:00:00Z");
  const messages: CanonicalMessage[] = [
    ...input().messages,
    { role: "assistant", content: [{ type: "tool_call", id: "read-1", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "read-1", content: [{ type: "text", text: "file" }] }] },
  ];
  const rollover = await runtime.prepareForModel(input({ messages }));
  assert.deepEqual(rollover.messages.slice(0, 3), messages);
  assert.equal(rollover.messages[3].metadata?.purpose, "date_update");
  assert.deepEqual(queries, ["request", "request"]);
  assert.equal(messages.length, 3);
});
