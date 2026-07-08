import assert from "node:assert/strict";
import test from "node:test";

import {
  AutoCompactionPolicy,
  CompactionEngine,
  DefaultContextRuntime,
  MicroCompactionEngine,
  SnipEngine,
  TokenAccountingRuntime,
  TokenBudgetManager,
  type TokenBudgetSnapshot,
} from "../../src/context/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest, CanonicalToolSchema, ModelConfig } from "../../src/model/index.js";

function user(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolTurn(name: string, id: string, resultText: string): CanonicalMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool_call", id, name, input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: id, content: [{ type: "text", text: resultText }] }] },
  ];
}

function snapshot(state: TokenBudgetSnapshot["state"]): TokenBudgetSnapshot {
  return {
    tokens: state === "blocking" ? 96 : state === "warning" ? 81 : 20,
    maxContextTokens: 100,
    warningRatio: 0.8,
    blockingRatio: 0.95,
    state,
    ratio: state === "blocking" ? 0.96 : state === "warning" ? 0.81 : 0.2,
  };
}

test("warning auto compact only applies micro and does not escalate to full", async () => {
  let fullRuns = 0;
  const runtime = new DefaultContextRuntime({
    tokenBudget: new TokenBudgetManager(),
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget: new TokenBudgetManager() }),
    microCompaction: new MicroCompactionEngine({ trimToBytes: 8, keepLatest: 0 }),
    compactionEngine: {
      async run() {
        fullRuns += 1;
        throw new Error("full compaction should not run at warning threshold");
      },
    } as unknown as CompactionEngine,
    maxContextTokens: 100,
  });
  const messages = [
    ...toolTurn("read_file", "call_1", "x".repeat(128)),
    user("continue"),
  ];
  const result = await runtime.tryAutoCompact({
    messages,
    budgetEvaluator: async (candidate) => candidate === messages ? snapshot("warning") : snapshot("warning"),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.type === "compacted" ? result.tier : undefined, "micro");
  assert.equal(fullRuns, 0);
});

test("blocking auto compact escalates from micro to snip when still blocking", async () => {
  const runtime = new DefaultContextRuntime({
    tokenBudget: new TokenBudgetManager(),
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget: new TokenBudgetManager() }),
    microCompaction: new MicroCompactionEngine({ trimToBytes: 8, keepLatest: 0 }),
    snipEngine: new SnipEngine({ keepHeadTurns: 1, keepTailTurns: 1 }),
    maxContextTokens: 100,
  });
  const messages = [
    user("start"),
    assistant("a"),
    ...toolTurn("read_file", "call_1", "x".repeat(128)),
    user("middle one"),
    assistant("b"),
    user("middle two"),
    assistant("c"),
    user("end"),
  ];
  const result = await runtime.tryAutoCompact({
    messages,
    budgetEvaluator: async (candidate) => {
      if (candidate.length < messages.length) return snapshot("ok");
      return snapshot("blocking");
    },
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.type === "compacted" ? result.tier : undefined, "snip");
});

test("blocking auto compact skips full compaction when summary fails", async () => {
  const runtime = new DefaultContextRuntime({
    tokenBudget: new TokenBudgetManager(),
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget: new TokenBudgetManager() }),
    compactionEngine: {
      async run() {
        return {
          trigger: "auto",
          preTokens: 100,
          boundaryMarker: user("boundary"),
          messagesToKeep: [user("tail")],
          attachments: [],
          hookResults: [],
          diagnostics: [{ code: "compact_summary_failed", severity: "error", message: "summarizer down" }],
          error: "summarizer down",
        };
      },
    } as unknown as CompactionEngine,
    maxContextTokens: 100,
  });
  const messages = [user("important old context"), user("tail")];
  const result = await runtime.tryAutoCompact({
    messages,
    budgetEvaluator: async () => snapshot("blocking"),
  });

  assert.equal(result.type, "skipped");
});

test("blocking auto compact skips full compaction when compacted prompt remains blocking", async () => {
  const runtime = new DefaultContextRuntime({
    tokenBudget: new TokenBudgetManager(),
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget: new TokenBudgetManager() }),
    compactionEngine: {
      async run() {
        return {
          trigger: "auto",
          preTokens: 100,
          summaryMessage: assistant("summary"),
          boundaryMarker: user("boundary"),
          messagesToKeep: [user("large protected output")],
          attachments: [],
          hookResults: [],
          diagnostics: [],
        };
      },
    } as unknown as CompactionEngine,
    maxContextTokens: 100,
  });
  const messages = [user("old context"), user("large protected output")];
  const result = await runtime.tryAutoCompact({
    messages,
    budgetEvaluator: async () => snapshot("blocking"),
  });

  assert.equal(result.type, "skipped");
  assert.equal(result.snapshot.state, "blocking");
});

test("protected tool results survive micro and snip compaction", () => {
  const protectedMessages = [
    user("start"),
    ...toolTurn("read_skill", "protected_call", "important skill output".repeat(20)),
    user("middle"),
    ...toolTurn("read_file", "compact_call", "ordinary file output".repeat(20)),
    user("end"),
  ];

  const micro = new MicroCompactionEngine({ trimToBytes: 8, keepLatest: 0 });
  const microResult = micro.apply({ messages: protectedMessages });
  const protectedAfterMicro = JSON.stringify(microResult.messages);
  assert.match(protectedAfterMicro, /important skill output/);

  const snip = new SnipEngine({ keepHeadTurns: 1, keepTailTurns: 1 });
  const snipResult = snip.snip([
    user("h"),
    assistant("h2"),
    ...protectedMessages,
    user("tail"),
  ]);
  const protectedAfterSnip = JSON.stringify(snipResult.messages);
  assert.match(protectedAfterSnip, /important skill output/);
});

test("memory context turn survives snip compaction", () => {
  const snip = new SnipEngine({ keepHeadTurns: 1, keepTailTurns: 1 });
  const result = snip.snip([
    user("head"),
    assistant("head answer"),
    user("middle 1"),
    assistant("middle answer"),
    user("<memory-context>\nremember this"),
    assistant("memory ack"),
    user("tail"),
  ]);
  assert.equal(result.applied, true);
  assert.match(JSON.stringify(result.messages), /<memory-context>/);
});

test("token accounting falls back to local estimate when provider count fails", async () => {
  const modelConfig: ModelConfig = {
    providers: {
      openai: {
        id: "openai",
        protocol: "openai",
        url: "https://api.openai.com/v1",
        apiKey: "test",
        headers: {},
        models: { "gpt-test": { id: "gpt-test", capabilities: DEFAULT_MODEL_CAPABILITIES, multimodal: { input: [] } } },
      },
    },
  };
  const accounting = new TokenAccountingRuntime({
    modelConfig,
    fetch: async () => {
      throw new Error("network down");
    },
  });
  const result = await accounting.countRequestInput({
    provider: "openai",
    model: "gpt-test",
    messages: [user("hello")],
  });
  assert.equal(result.source, "local");
  assert.equal(result.exact, false);
  assert.ok(result.tokens > 0);
  assert.match(result.estimatorError ?? "", /network down/);
});

async function* compactSummaryStream(): AsyncIterable<CanonicalModelEvent> {
  yield { type: "text_delta", text: "## Objective\nDone\n## Current State\nOk\n## Remaining\nNone\n## Files And Artifacts\nNone" };
  yield { type: "message_end", finishReason: "stop" };
}

test("full compaction preserves protected turns outside summary", async () => {
  const engine = new CompactionEngine({
    provider: "p",
    model_: "m",
    model: { stream: () => compactSummaryStream() },
  });
  const result = await engine.run({
    trigger: "auto",
    keepTailRatio: 0.25,
    messages: [
      user("head"),
      assistant("head answer"),
      ...toolTurn("read_skill", "skill_call", "skill output must remain"),
      user("tail"),
    ],
  });

  assert.match(JSON.stringify(result.messagesToKeep), /skill output must remain/);
  assert.deepEqual(result.diagnostics, []);
});

test("agent loop does not run post-routing compaction when only reserved output changes snapshot budget", async () => {
  const { AgentLoop } = await import("../../src/agent/index.js");
  const { ToolRegistry } = await import("../../src/tool/index.js");
  const { createDefaultPermissionContext } = await import("../../src/permission/index.js");

  let compactCalls = 0;
  const contextRuntime = {
    async prepareForModel(input: { messages: CanonicalMessage[]; tools: CanonicalToolSchema[] }) {
      return {
        messages: input.messages,
        systemPrompt: undefined,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
        metadata: {},
      };
    },
    async tryAutoCompact() {
      compactCalls += 1;
      return {
        type: "skipped" as const,
        snapshot: {
          tokens: 1,
          maxContextTokens: 100 - 10,
          warningRatio: 0.8,
          blockingRatio: 0.95,
          state: "ok" as const,
          ratio: 1 / 90,
          reservedOutputTokens: 10,
        },
      };
    },
  };

  const loop = new AgentLoop({
    provider: "p",
    model: "m",
    cwd: "/tmp",
    maxContextTokens: 100,
    maxOutputTokens: 10,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "/tmp" }),
  }, {
    router: {
      async decide({ request }) {
        return {
          provider: request.provider,
          model: request.model,
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute() {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "done" };
        yield { type: "message_end", finishReason: "stop" };
      },
      async *stream() {},
      materializeRequest(_decision, request) {
        return request;
      },
    },
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
    context: contextRuntime,
    getModelMaxContextTokens: () => 100,
  });

  const events = [];
  for await (const event of loop.run({
    sessionId: "s",
    turnId: "t",
    messages: [user("hello")],
  })) {
    events.push(event.type);
  }

  assert.equal(compactCalls, 1);
  assert.equal(events.filter((event) => event === "context_budget").length, 1);
});
