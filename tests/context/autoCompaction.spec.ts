import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import {
  CompactionEngine,
  truncateHeadPreservingCheckpoint,
} from "../../src/context/compaction/CompactionEngine.js";
import { MicroCompactionEngine } from "../../src/context/compaction/MicroCompactionEngine.js";
import { SnipEngine } from "../../src/context/compaction/SnipEngine.js";
import { isRealUserRequestMessage } from "../../src/context/compaction/toolPairIntegrity.js";
import { projectToolResults } from "../../src/agent/loop/projectToolResults.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../src/model/index.js";

test("auto-compaction summarizes earlier work instead of deleting it", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    maxOutputTokens: 1,
    tokenBudget,
    model: {
      async *stream(request) {
        summaryRequests.push(request);
        yield { type: "text_delta", text: "## Current state\n- kept the workspace findings" };
      },
    },
  });
  const messages = textMessages(
    "Original task: update the workspace.",
    "Completed: wrote /tmp/project/output.json.",
    "Recent question: continue from the generated artifact.",
    "Assistant: inspecting the generated artifact.",
    "Recent status: artifact exists and is readable.",
    "Assistant: ready for the next instruction.",
    "Final recent question: continue.",
  );
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 1,
  });

  const result = await runtime.tryAutoCompact({ messages });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "emergency");
  assert.equal(summaryRequests.some((request) => /\/tmp\/project\/output\.json/.test(textFrom(request.messages))), true);
  assert.match(textFrom(result.messages), /kept the workspace findings/);
});

test("auto-compaction keeps the original transcript when summary generation fails", async () => {
  const tokenBudget = new TokenBudgetManager();
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    tokenBudget,
    model: {
      async *stream() {
        yield {
          type: "error" as const,
          error: {
            provider: "test",
            protocol: "openai" as const,
            code: "server_error",
            message: "summary provider unavailable",
            retryable: true,
          },
        };
      },
    },
  });
  const messages = textMessages(
    "Original task: preserve the artifact map.",
    "Completed: wrote /tmp/project/output.json.",
    "Recent question: continue.",
    "Assistant: waiting.",
    "Current status: artifact map is available.",
    "Assistant: ready.",
    "Final recent question: continue.",
  );
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });

  let evaluations = 0;
  const result = await runtime.tryAutoCompact({
    messages,
    budgetEvaluator: (candidate) => {
      evaluations += 1;
      assert.deepEqual(candidate, messages);
      return Promise.resolve(tokenBudget.snapshotFromTokens(evaluations === 1 ? 95 : 85, 100));
    },
  });

  assert.equal(result.type, "skipped");
  assert.equal(
    textFrom(messages),
    "Original task: preserve the artifact map.\nCompleted: wrote /tmp/project/output.json.\nRecent question: continue.\nAssistant: waiting.\nCurrent status: artifact map is available.\nAssistant: ready.\nFinal recent question: continue.",
  );
});

test("reactive summary failure uses emergency truncation without fabricating a checkpoint", async () => {
  const tokenBudget = new TokenBudgetManager();
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    tokenBudget,
    model: {
      async *stream() {
        yield {
          type: "error" as const,
          error: {
            provider: "test",
            protocol: "openai" as const,
            code: "server_error",
            message: "summary provider unavailable",
            retryable: true,
          },
        };
      },
    },
  });
  const messages = textMessages(
    "Original task: preserve the artifact map.",
    "Completed: wrote /tmp/project/output.json.",
    "Recent question: continue.",
    "Assistant: waiting.",
    "Current status: artifact map is available.",
    "Assistant: ready.",
    "Final recent question: continue.",
  );
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 1,
  });

  const result = await runtime.tryAutoCompact({ messages, allowFallbackOnFailure: true });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "emergency");
  assert.equal(result.result, undefined);
  assert.doesNotMatch(textFrom(result.messages), /<compact-boundary/);
  assert.match(textFrom(result.messages), /Final recent question: continue/);
});

test("protected early tool turns do not bypass emergency compaction", async () => {
  const tokenBudget = new TokenBudgetManager();
  let summaryCalls = 0;
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    tokenBudget,
    model: {
      async *stream() {
        summaryCalls += 1;
        yield { type: "text_delta", text: "## Objective\nKeep the current task." };
      },
    },
  });
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "Start the task." }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "skill-1", name: "read_skill", input: { skillName: "example" } }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "skill-1",
        content: [{ type: "text", text: "protected skill output ".repeat(3_000) }],
      }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "read-1", name: "read_file", input: { file_path: "/tmp/large.txt" } }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "read-1",
        content: [{ type: "text", text: "large file output ".repeat(3_000) }],
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "Ready for the next request." }] },
  ];
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    microCompaction: new MicroCompactionEngine(),
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages,
    budgetEvaluator: (candidate) => Promise.resolve(
      tokenBudget.snapshotFromTokens(textFrom(candidate).includes("[CONTEXT COMPACTION - REFERENCE ONLY]") ? 70 : 120, 100),
    ),
  });

  assert.equal(result.type, "compacted");
  assert.equal(summaryCalls, 1);
  assert.equal(textFrom(result.messages).includes("[CONTEXT COMPACTION - REFERENCE ONLY]"), true);
});

test("80% pre-summary prune can stay below 90% without calling the summary model", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    model: {
      async *stream(request) {
        summaryRequests.push(request);
        yield { type: "text_delta", text: "summary" };
      },
    },
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    microCompaction: new MicroCompactionEngine(),
    maxContextTokens: 100,
  });
  const result = await runtime.tryAutoCompact({
    messages: largeToolResultFixture(),
    budgetEvaluator: (candidate) => Promise.resolve(
      tokenBudget.snapshotFromTokens(hasMicroMarker(candidate) ? 84 : 86, 100),
    ),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "micro");
  assert.equal(summaryRequests.length, 0);
});

test("summary runs before post-summary snip and keeps the compact checkpoint", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    model: {
      async *stream(request) {
        summaryRequests.push(request);
        yield { type: "text_delta", text: "## Objective\nKeep the checkpoint." };
      },
    },
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    snipEngine: new SnipEngine({ keepHeadTurns: 0, keepTailTurns: 1 }),
    maxContextTokens: 100,
  });
  const result = await runtime.tryAutoCompact({
    messages: textMessages(...Array.from({ length: 24 }, (_, index) => `turn-${index}`)),
    budgetEvaluator: (candidate) => Promise.resolve(
      tokenBudget.snapshotFromTokens(
        hasSnipBoundary(candidate) ? 55 : hasCompactSummary(candidate) ? 95 : 100,
        100,
      ),
    ),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "full");
  assert.equal(summaryRequests.length, 1);
  assert.equal(hasSnipBoundary(result.messages), true);
  assert.match(textFrom(result.messages), /Keep the checkpoint/);
  assert.equal(result.result?.targetPostTokens, 60);
});

test("targeted snip can prune tool cycles inside one user task", () => {
  const messages: CanonicalMessage[] = [{
    role: "user",
    content: [{ type: "text", text: "Inspect each repository file." }],
  }];
  for (let index = 0; index < 6; index += 1) {
    messages.push(
      {
        role: "assistant",
        content: [{ type: "tool_call", id: `cycle-${index}`, name: "read_file", input: { path: `src/file-${index}.ts` } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          toolCallId: `cycle-${index}`,
          content: [{ type: "text", text: `file-${index} ${"content ".repeat(300)}` }],
        }],
      },
    );
  }

  const result = new SnipEngine().snip(messages, { targetTotalTokens: 1_000 });
  const callIds = result.messages.flatMap((message) => message.content.flatMap((block) =>
    block.type === "tool_call" ? [block.id] : [],
  ));
  const resultIds = result.messages.flatMap((message) => message.content.flatMap((block) =>
    block.type === "tool_result" ? [block.toolCallId] : [],
  ));

  assert.equal(result.applied, true);
  assert.ok(result.turnsSnipped > 0);
  assert.equal(callIds.includes("cycle-0"), false);
  assert.equal(callIds.includes("cycle-5"), true);
  assert.deepEqual(resultIds, callIds);
  const requestIndex = result.messages.findIndex((message) =>
    textFrom([message]) === "Inspect each repository file."
  );
  const retainedTailIndex = result.messages.findIndex((message) =>
    message.content.some((block) => block.type === "tool_call" && block.id === "cycle-5")
  );
  assert.ok(requestIndex >= 0);
  assert.ok(retainedTailIndex > requestIndex);
});

test("emergency head truncation keeps the latest task query", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "Old completed request" }] },
    { role: "assistant", content: [{ type: "text", text: "Old request completed" }] },
    { role: "user", content: [{ type: "text", text: "Current request must survive" }] },
  ];
  for (let index = 0; index < 4; index += 1) {
    messages.push(
      {
        role: "assistant",
        content: [{ type: "tool_call", id: `truncate-${index}`, name: "read_file", input: { path: `file-${index}` } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          toolCallId: `truncate-${index}`,
          content: [{ type: "text", text: `result-${index}` }],
        }],
      },
    );
  }

  const result = truncateHeadPreservingCheckpoint(messages, 0.1);
  const callIds = result.flatMap((message) => message.content.flatMap((block) =>
    block.type === "tool_call" ? [block.id] : [],
  ));
  const resultIds = result.flatMap((message) => message.content.flatMap((block) =>
    block.type === "tool_result" ? [block.toolCallId] : [],
  ));

  assert.match(textFrom(result), /Current request must survive/);
  assert.doesNotMatch(textFrom(result), /Old completed request/);
  assert.ok(result.length > 0);
  assert.deepEqual(resultIds, callIds);
});

test("query anchoring excludes synthetic and internal user messages", () => {
  const internalMessages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "tool_result", toolCallId: "tool-1", content: [] }] },
    { role: "user", content: [{ type: "text", text: "<memory-context>memory</memory-context>" }] },
    { role: "user", content: [{ type: "text", text: "<compact-boundary trigger=\"auto\" />" }] },
    { role: "user", content: [{ type: "text", text: "<snip-boundary turnsSnipped=\"1\" />" }] },
    { role: "user", content: [{ type: "text", text: "<hook_context source=\"UserPromptSubmit\">Injected context</hook_context>" }] },
    {
      role: "user",
      content: [{ type: "text", text: "retry the generated response" }],
      metadata: { synthetic: true },
    },
    {
      role: "user",
      content: [{
        type: "text",
        text: "[system: the conversation above has been compacted. please continue with the current task.]",
      }],
    },
  ];

  assert.equal(isRealUserRequestMessage({
    role: "user",
    content: [{ type: "text", text: "Actual request" }],
  }), true);
  assert.equal(internalMessages.every((message) => !isRealUserRequestMessage(message)), true);
});

test("query anchoring excludes inline supplemental media from tool results", () => {
  const projected = projectToolResults([{
    type: "success",
    toolCallId: "read-file-1",
    toolName: "read_file",
    content: [{ type: "text", text: "Rendered PDF pages." }],
    supplementalMessages: [{
      role: "user",
      isMeta: true,
      content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=", bytes: 5 }],
    }],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  }]);

  const supplemental = projected[1]!;
  assert.equal(supplemental.metadata?.synthetic, true);
  assert.equal(supplemental.metadata?.purpose, "tool_result_supplemental");
  assert.equal(supplemental.metadata?.toolCallId, "read-file-1");
  assert.equal(isRealUserRequestMessage(supplemental), false);
});

test("emergency head truncation preserves empty history", () => {
  assert.deepEqual(truncateHeadPreservingCheckpoint([], 0.1), []);
});

test("request anchoring skips hook context before a multi-turn tool cycle", () => {
  const messages: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "Actual user request" }] },
    { role: "user", content: [{ type: "text", text: "<hook_context source=\"UserPromptSubmit\">Injected context</hook_context>" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "hook-cycle", name: "read_file", input: { path: "a.txt" } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "hook-cycle", content: [{ type: "text", text: "tool output" }] }] },
  ];

  const result = truncateHeadPreservingCheckpoint(messages, 0.1);
  assert.match(textFrom(result), /Actual user request/);
  assert.doesNotMatch(textFrom(result), /Injected context/);
});

test("full compaction targets 60% of the effective input budget", async () => {
  async function compactWithReserve(reservedOutputTokens: number, compactedTokens: number) {
    const tokenBudget = new TokenBudgetManager();
    const engine = new CompactionEngine({
      provider: "test",
      model_: "test-model",
      maxOutputTokens: 1,
      model: {
        async *stream() {
          yield { type: "text_delta" as const, text: "## Objective\nKeep working." };
        },
      },
    });
    const runtime = new DefaultContextRuntime({
      tokenBudget,
      autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
      compactionEngine: engine,
      maxContextTokens: 110_000,
    });
    return runtime.tryAutoCompact({
      messages: textMessages(...Array.from({ length: 40 }, (_, index) => `turn-${index} `.repeat(50))),
      reservedOutputTokens,
      budgetEvaluator: (candidate) => Promise.resolve(tokenBudget.snapshotFromTokens(
        hasCompactSummary(candidate) ? compactedTokens : 70_000,
        110_000,
        { reservedOutputTokens },
      )),
    });
  }

  const legacyReserve = await compactWithReserve(65_536, 26_000);
  assert.equal(legacyReserve.type, "compacted");
  assert.equal(legacyReserve.result?.targetPostTokens, 26_678);
  assert.ok(legacyReserve.snapshot.ratio <= 0.60);

  const currentDefault = await compactWithReserve(32_768, 46_000);
  assert.equal(currentDefault.type, "compacted");
  assert.equal(currentDefault.result?.targetPostTokens, 46_339);
  assert.ok(currentDefault.snapshot.ratio <= 0.60);
});

test("zero-message summaries are skipped when compaction makes no effective change", async () => {
  const tokenBudget = new TokenBudgetManager();
  let summaryCalls = 0;
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    model: {
      async *stream() {
        summaryCalls += 1;
        yield { type: "text_delta" as const, text: "unused" };
      },
    },
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });
  const result = await runtime.tryAutoCompact({
    messages: [{ role: "user", content: [{ type: "text", text: "Only protected current request" }] }],
    budgetEvaluator: (candidate) => Promise.resolve(tokenBudget.snapshotFromTokens(
      textFrom(candidate).includes("<compact-boundary") ? 50 : 95,
      100,
    )),
  });

  assert.equal(result.type, "skipped");
  assert.equal(summaryCalls, 0);
});

test("rolling-summary replacement with no live history succeeds without emergency compaction", async () => {
  const tokenBudget = new TokenBudgetManager();
  let summaryCalls = 0;
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    model: {
      async *stream() {
        summaryCalls += 1;
        yield {
          type: "text_delta" as const,
          text: summaryCalls === 1 ? "## Objective\nInitial checkpoint." : "## Objective\nReplacement checkpoint.",
        };
        yield { type: "message_end" as const, finishReason: "stop" };
      },
    },
  });
  const previous = await engine.run({
    trigger: "auto",
    messages: textMessages(
      "Earlier request",
      "Earlier result",
      "Earlier follow-up",
      "Earlier response",
      "Earlier status",
      "Earlier conclusion",
      "Earlier next step",
    ),
    keepTailRatio: 0.05,
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages: [previous.boundaryMarker, previous.summaryMessage!, {
      role: "user",
      content: [{ type: "text", text: "Required current request" }],
    }],
    budgetEvaluator: (candidate) => Promise.resolve(tokenBudget.snapshotFromTokens(
      textFrom(candidate).includes("Replacement checkpoint") ? 50 : 95,
      100,
    )),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "full");
  assert.equal(result.result?.messagesSummarized, 0);
  assert.equal(result.result?.summaryGenerated, true);
  assert.equal(summaryCalls, 2);
});

test("zero-message compaction reports overflow instead of skipped above the hard budget", async () => {
  const tokenBudget = new TokenBudgetManager();
  let summaryCalls = 0;
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: new CompactionEngine({
      provider: "test",
      model_: "test-model",
      model: {
        async *stream() {
          summaryCalls += 1;
        },
      },
    }),
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages: [{ role: "user", content: [{ type: "text", text: "Only protected current request" }] }],
    budgetEvaluator: () => Promise.resolve(tokenBudget.snapshotFromTokens(110, 100)),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.error, "context_overflow_after_emergency_compaction");
  assert.equal(summaryCalls, 0);
});

test("pre-summary tool projection is idempotent", () => {
  const engine = new MicroCompactionEngine();
  const first = engine.apply({ messages: largeToolResultFixture() });
  const second = engine.apply({ messages: first.messages });
  assert.ok(first.rewritten > 0);
  assert.equal(second.rewritten, 0);
});

test("per-call protected-tool overrides replace the constructor set", () => {
  const engine = new MicroCompactionEngine({
    keepLatest: 1,
    protectedToolNames: ["read_file"],
  });
  const messages = largeToolResultFixture();

  const constructorProtected = engine.apply({ messages, trimToTokens: 64 });
  assert.equal(constructorProtected.rewritten, 0);

  const perCallOverride = engine.apply({
    messages,
    trimToTokens: 64,
    protectedToolNames: [],
  });
  assert.ok(perCallOverride.rewritten > 0);
});

test("emergency compaction reports an explicit overflow instead of permitting another model retry", async () => {
  const tokenBudget = new TokenBudgetManager();
  let summaryCalls = 0;
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    tokenBudget,
    model: {
      async *stream() {
        summaryCalls += 1;
        yield { type: "text_delta", text: "## Objective\nKeep the current request." };
      },
    },
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages: textMessages(...Array.from({ length: 20 }, (_, index) => `turn-${index}`)),
    budgetEvaluator: () => Promise.resolve(tokenBudget.snapshotFromTokens(120, 100)),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.error, "context_overflow_after_emergency_compaction");
  assert.ok(summaryCalls >= 2);
  assert.ok(result.result?.diagnostics.some((diagnostic) => diagnostic.code === "context_hard_truncate"));
  assert.ok(result.result?.diagnostics.some((diagnostic) => diagnostic.code === "context_overflow_after_emergency_compaction"));
});

test("emergency compaction keeps a sendable prompt below the hard budget", async () => {
  const tokenBudget = new TokenBudgetManager();
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    tokenBudget,
    model: {
      async *stream() {
        yield { type: "text_delta", text: "## Objective\nContinue the task." };
      },
    },
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages: textMessages(...Array.from({ length: 20 }, (_, index) => `turn-${index}`)),
    budgetEvaluator: () => Promise.resolve(tokenBudget.snapshotFromTokens(95, 100)),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.error, undefined);
});

test("emergency summary remains persistable after a later head truncation", async () => {
  const tokenBudget = new TokenBudgetManager();
  let summaryCalls = 0;
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    tokenBudget,
    model: {
      async *stream() {
        summaryCalls += 1;
        yield { type: "text_delta", text: `## Objective\nCheckpoint ${summaryCalls}.` };
      },
    },
  });
  const runtime = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine: engine,
    maxContextTokens: 100,
  });

  const result = await runtime.tryAutoCompact({
    messages: textMessages(...Array.from({ length: 20 }, (_, index) => `turn-${index}`)),
    // Keep the simulated routed request in emergency territory after the
    // summary so the emergency path continues through head truncation.
    budgetEvaluator: () => Promise.resolve(tokenBudget.snapshotFromTokens(95, 100)),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "emergency");
  assert.ok(summaryCalls >= 2);
  assert.ok(result.result?.summaryMessage);
  assert.match(textFrom(result.messages), /Checkpoint 2/);
});

test("emergency tool projection may tighten a bounded preview once, then remains idempotent", () => {
  const engine = new MicroCompactionEngine();
  const first = engine.apply({ messages: largeToolResultFixture() });
  const emergency = engine.apply({ messages: first.messages, trimToTokens: 256, keepLatest: 1 });
  const repeated = engine.apply({ messages: emergency.messages, trimToTokens: 256, keepLatest: 1 });

  assert.ok(first.rewritten > 0);
  assert.ok(emergency.rewritten > 0);
  assert.equal(repeated.rewritten, 0);
});

function textMessages(...texts: string[]): CanonicalMessage[] {
  return texts.map((text, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text }],
  }));
}

function textFrom(messages: CanonicalMessage[]): string {
  return messages.flatMap((message) => message.content.flatMap((block) =>
    block.type === "text" ? [block.text] : [],
  )).join("\n");
}

function hasCompactSummary(messages: CanonicalMessage[]): boolean {
  return textFrom(messages).includes("[CONTEXT COMPACTION - REFERENCE ONLY]");
}

function hasMicroMarker(messages: CanonicalMessage[]): boolean {
  return textFrom(messages).includes("[Old tool result content compacted]");
}

function hasSnipBoundary(messages: CanonicalMessage[]): boolean {
  return textFrom(messages).includes("<snip-boundary");
}

function largeToolResultFixture(): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (let index = 0; index < 5; index += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_call", id: `read-${index}`, name: "read_file", input: { file_path: `/tmp/file-${index}.txt` } }],
    });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: `read-${index}`,
        content: [{ type: "text", text: `output-${index} `.repeat(1_200) }],
      }],
    });
  }
  return messages;
}
