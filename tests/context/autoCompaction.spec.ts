import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { AutoCompactionPolicy } from "../../src/context/compaction/AutoCompactionPolicy.js";
import { CompactionEngine } from "../../src/context/compaction/CompactionEngine.js";
import { MicroCompactionEngine } from "../../src/context/compaction/MicroCompactionEngine.js";
import { SnipEngine } from "../../src/context/compaction/SnipEngine.js";
import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../src/model/index.js";

test("auto-compaction summarizes earlier work instead of deleting it", async () => {
  const tokenBudget = new TokenBudgetManager();
  const summaryRequests: CanonicalModelRequest[] = [];
  const engine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
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
    maxContextTokens: 1,
  });

  const result = await runtime.tryAutoCompact({ messages });

  assert.equal(result.type, "skipped");
  assert.equal(
    textFrom(messages),
    "Original task: preserve the artifact map.\nCompleted: wrote /tmp/project/output.json.\nRecent question: continue.\nAssistant: waiting.\nCurrent status: artifact map is available.\nAssistant: ready.\nFinal recent question: continue.",
  );
});

test("reactive fallback keeps a deterministic checkpoint when summary generation fails", async () => {
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
  assert.match(textFrom(result.messages), /\/tmp\/project\/output\.json/);
  assert.match(result.result?.error ?? "", /summary provider unavailable/);
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
    snipEngine: new SnipEngine({ keepHeadTurns: 1, keepTailTurns: 2 }),
    maxContextTokens: 100,
  });
  const result = await runtime.tryAutoCompact({
    messages: textMessages(...Array.from({ length: 24 }, (_, index) => `turn-${index}`)),
    budgetEvaluator: (candidate) => Promise.resolve(
      tokenBudget.snapshotFromTokens(
        hasSnipBoundary(candidate) ? 75 : hasCompactSummary(candidate) ? 95 : 100,
        100,
      ),
    ),
  });

  assert.equal(result.type, "compacted");
  assert.equal(result.tier, "full");
  assert.equal(summaryRequests.length, 1);
  assert.equal(hasSnipBoundary(result.messages), true);
  assert.match(textFrom(result.messages), /Keep the checkpoint/);
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
