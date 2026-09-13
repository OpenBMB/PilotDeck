import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { MicroCompactionEngine } from "../../src/context/compaction/MicroCompactionEngine.js";
import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
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

function checkpoint(text: string): CanonicalMessage[] {
  return [
    message('<compact-boundary trigger="manual" />'),
    { role: "assistant", content: [{ type: "text", text: `[CONTEXT COMPACTION - REFERENCE ONLY]\n${text}` }] },
    message("continue"),
  ];
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

test("pruning and local rewrites preserve the system date", async () => {
  for (const rewritten of [
    [message("tail")], // Head truncation / overflow recovery.
    [message("head"), message("short tool result"), message("tail")], // Micro compaction.
    [message("head"), message("tail")], // Middle snip with stable head.
  ]) {
    let now = new Date("2026-09-10T12:00:00Z");
    const runtime = new DefaultContextRuntime({ now: () => now });
    await runtime.prepareForModel(input({ messages: [message("head"), message("long tool result"), message("tail")] }));
    now = new Date("2026-09-11T12:00:00Z");
    const compacted = await runtime.prepareForModel(input({ messages: rewritten }));
    assert.equal(promptDate(compacted), "2026-09-10");
    now = new Date("2026-09-12T12:00:00Z");
    const next = await runtime.prepareForModel(input({ messages: [...rewritten, message("next")] }));
    assert.equal(promptDate(next), "2026-09-10");
  }
});

test("sliding window preserves the system date when projected history changes", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  const messages = [message("old"), message("head"), message("tail")];
  await runtime.prepareForModel(input({ messages, maxMessages: 2 }));
  now = new Date("2026-09-11T12:00:00Z");
  const retry = await runtime.prepareForModel(input({ messages, maxMessages: 2 }));
  assert.equal(promptDate(retry), "2026-09-10");
  const advanced = await runtime.prepareForModel(input({ messages: [...messages, message("next")], maxMessages: 2 }));
  assert.equal(promptDate(advanced), "2026-09-10");
});

test("discarded budget candidates do not change the live date or cache generation", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  const first = await runtime.prepareForModel(input());
  now = new Date("2026-09-11T12:00:00Z");
  const candidate = await runtime.prepareForModel(input({ previewOnly: true, messages: checkpoint("hypothetical summary") }));
  assert.equal(promptDate(candidate), "2026-09-10");
  const unchanged = await runtime.prepareForModel(input());
  assert.equal(unchanged.systemPrompt, first.systemPrompt);
  assert.equal(unchanged.cachePlan?.generation, (first.cachePlan?.generation ?? 0) + 1);
  assert.equal(dateUpdates(unchanged).length, 1);
  const committed = await runtime.prepareForModel(input({ messages: checkpoint("hypothetical summary") }));
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

test("full compaction retires rollover messages and refreshes the system date", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  await runtime.prepareForModel(input());
  now = new Date("2026-09-11T12:00:00Z");
  assert.equal(dateUpdates(await runtime.prepareForModel(input())).length, 1);
  const rewritten = await runtime.prepareForModel(input({ messages: checkpoint("summary") }));
  assert.equal(promptDate(rewritten), "2026-09-11");
  assert.equal(dateUpdates(rewritten).length, 0);
  const next = await runtime.prepareForModel(input({ messages: [...checkpoint("summary"), message("continue")] }));
  assert.equal(dateUpdates(next).length, 0);
  now = new Date("2026-09-12T12:00:00Z");
  const pruned = await runtime.prepareForModel(input({ messages: checkpoint("summary") }));
  assert.equal(promptDate(pruned), "2026-09-11");
  assert.equal(dateUpdates(pruned).length, 1);
  const compactedAgain = await runtime.prepareForModel(input({ messages: checkpoint("new summary") }));
  assert.equal(promptDate(compactedAgain), "2026-09-12");
  assert.equal(dateUpdates(compactedAgain).length, 0);
});

test("micro-compaction cache resets do not refresh the prompt date", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({
    now: () => now,
    microCompaction: new MicroCompactionEngine(),
    tokenBudget: new TokenBudgetManager(),
    autoCompactionPolicy: new AutoCompactionPolicy(),
  });
  const messages: CanonicalMessage[] = [message("inspect these files")];
  for (let index = 0; index < 5; index += 1) {
    messages.push(
      { role: "assistant", content: [{ type: "tool_call", id: `read-${index}`, name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: `read-${index}`, content: [{ type: "text", text: "source code line\n".repeat(1000) }] }] },
    );
  }
  const first = await runtime.prepareForModel(input({ messages }));
  now = new Date("2026-09-11T12:00:00Z");
  let evaluations = 0;
  const compacted = await runtime.tryAutoCompact({
    sessionId: input().sessionId,
    messages,
    budgetEvaluator: async () => ({
      tokens: ++evaluations === 1 ? 8500 : 7000,
      maxContextTokens: 10000,
      warningRatio: 0.8,
      blockingRatio: 0.9,
      state: evaluations === 1 ? "warning" : "ok",
      ratio: evaluations === 1 ? 0.85 : 0.7,
    }),
  });
  assert.equal(compacted.type, "compacted");
  if (compacted.type !== "compacted") return;
  assert.equal(compacted.tier, "micro");
  const prepared = await runtime.prepareForModel(input({ messages: compacted.messages }));
  assert.equal(prepared.systemPrompt, first.systemPrompt);
  assert.equal(dateUpdates(prepared).length, 1);
  assert.match(JSON.stringify(dateUpdates(prepared)), /2026-09-11/);
  assert.ok(prepared.cachePlan!.generation > first.cachePlan!.generation);
});

test("pruning preserves prefix notices and relocates affected notices safely", async () => {
  let now = new Date("2026-09-10T12:00:00Z");
  const runtime = new DefaultContextRuntime({ now: () => now });
  const first = await runtime.prepareForModel(input());
  now = new Date("2026-09-11T12:00:00Z");
  const rollover = await runtime.prepareForModel(input());
  const messages: CanonicalMessage[] = [
    ...input().messages,
    { role: "assistant", content: [{ type: "tool_call", id: "read", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "read", content: [{ type: "text", text: "long result" }] }] },
    message("continue"),
  ];
  now = new Date("2026-09-12T12:00:00Z");
  await runtime.prepareForModel(input({ messages }));
  const rewritten = [...messages];
  rewritten[2] = { role: "user", content: [{ type: "tool_result", toolCallId: "read", content: [{ type: "text", text: "short result" }] }] };
  const prepared = await runtime.prepareForModel(input({ messages: rewritten }));
  assert.equal(prepared.systemPrompt, first.systemPrompt);
  assert.deepEqual(prepared.messages.slice(0, rollover.messages.length), rollover.messages);
  assert.deepEqual(prepared.messages.slice(2, 4), rewritten.slice(1, 3));
  assert.equal(dateUpdates(prepared).length, 2);
  assert.equal(prepared.messages.at(-1)?.metadata?.purpose, "date_update");
  const preview = await runtime.prepareForModel(input({ previewOnly: true, messages: [message("continue")] }));
  assert.equal(preview.systemPrompt, first.systemPrompt);
  assert.deepEqual((await runtime.prepareForModel(input({ messages: rewritten }))).messages, prepared.messages);
  const truncated = await runtime.prepareForModel(input({ messages: [message("continue")] }));
  assert.equal(truncated.systemPrompt, first.systemPrompt);
  assert.equal(truncated.messages.length, 2);
  assert.equal(dateUpdates(truncated).length, 1);
  assert.match(JSON.stringify(dateUpdates(truncated)), /2026-09-12/);
  assert.deepEqual((await runtime.prepareForModel(input({ messages: [message("continue")] }))).messages, truncated.messages);
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
