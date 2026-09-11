import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalToolCall,
} from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import type {
  InvalidateStickyResult,
  RouterDecisionInput,
} from "../../../src/router/index.js";
import type { PilotDeckToolResult } from "../../../src/tool/protocol/result.js";
import { ToolRegistry } from "../../../src/tool/index.js";

type RoutingMetadata = NonNullable<RouterDecisionInput["metadata"]>;

type HarnessOptions = {
  userMessage?: string;
  isSubagent?: boolean;
  peekSticky?: (sessionId: string) => InvalidateStickyResult;
  invalidatedSticky?: InvalidateStickyResult;
  planSnapshot?: unknown | (() => unknown);
  recentFiles?: unknown | (() => unknown);
  scripts?: CanonicalModelEvent[][];
  toolResults?: PilotDeckToolResult[][];
  modelOverride?: { provider: string; model: string };
};

async function runHarness(options: HarnessOptions = {}) {
  const metadata: Array<RoutingMetadata | undefined> = [];
  let peekCount = 0;
  let invalidateCount = 0;
  let planSnapshotCount = 0;
  let scriptIndex = 0;
  let toolResultIndex = 0;

  const router: AgentRouterRuntime = {
    ...(options.peekSticky
      ? {
          peekSticky: (sessionId) => {
            peekCount += 1;
            return options.peekSticky!(sessionId);
          },
        }
      : {}),
    invalidateSticky: () => {
      invalidateCount += 1;
      return options.invalidatedSticky ?? { orchestrating: false };
    },
    decide: async (input) => {
      metadata.push(input.metadata);
      return {
        provider: input.request.provider,
        model: input.request.model,
        scenarioType: options.isSubagent ? "subagent" : "default",
        isSubagent: Boolean(options.isSubagent),
        orchestrating: false,
        resolvedFrom: "tokenSaver",
        mutations: {},
      };
    },
    execute: async function* () {
      const script = options.scripts?.[scriptIndex++] ?? finalResponse("done");
      for (const event of script) yield event;
    },
    stream: async function* () {
      yield* finalResponse("done");
    },
  };

  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll(calls) {
          return options.toolResults?.[toolResultIndex++] ?? calls.map(successResult);
        },
      },
    },
    ...(options.planSnapshot !== undefined
      ? {
          planTodoManager: {
            forSession: () => ({
              getSnapshot: () => {
                planSnapshotCount += 1;
                const source = typeof options.planSnapshot === "function"
                  ? options.planSnapshot()
                  : options.planSnapshot;
                return source as never;
              },
              markPlanApproved: () => undefined,
              recordTodoWrite: () => [],
              writeTodos: () => [],
              markToolProgressChanged: () => undefined,
              buildPromptAddendum: () => undefined,
              blockingMessageFor: () => undefined,
            }),
          },
        }
      : {}),
    ...(options.recentFiles !== undefined
      ? {
          fileHistory: {
            trackEdit: async () => undefined,
            getRecentTrackedFiles: () => {
              const source = typeof options.recentFiles === "function"
                ? options.recentFiles()
                : options.recentFiles;
              return source as string[];
            },
          },
        }
      : {}),
  };

  const config: AgentRuntimeConfig = {
    provider: "test-provider",
    model: "test-model",
    cwd: "/workspace/project",
    isSubagent: options.isSubagent,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const messages: CanonicalMessage[] = [{
    role: "user",
    content: [{ type: "text", text: options.userMessage ?? "implement it" }],
  }];
  const loop = new AgentLoop(config, dependencies);
  for await (const _event of loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages,
    modelOverride: options.modelOverride,
  })) {
    // Exhaust the scripted turn.
  }

  return {
    metadata,
    peekCount,
    invalidateCount,
    planSnapshotCount,
  };
}

test("complete short continuation preserves sticky facts for every decide in the turn", async () => {
  const call: CanonicalToolCall = { id: "call-1", name: "bash", input: { command: "echo ok" } };
  const result = await runHarness({
    userMessage: "继续",
    peekSticky: () => ({
      previousTier: " full ",
      previousProvider: " provider-a ",
      previousModel: " model-a ",
      orchestrating: false,
    }),
    scripts: [toolResponse([call]), finalResponse("done")],
  });

  assert.equal(result.peekCount, 1);
  assert.equal(result.invalidateCount, 0);
  assert.equal(result.metadata.length, 2);
  for (const metadata of result.metadata) {
    assert.deepEqual(metadata?.continuation, {
      matched: true,
      previousTier: "full",
      previousProvider: "provider-a",
      previousModel: "model-a",
    });
  }
});

test("expanded messages and unavailable sticky peeks keep the invalidation path", async (t) => {
  const cases: Array<{ name: string; options: HarnessOptions; expectedPeek: number }> = [
    {
      name: "expanded message",
      options: {
        userMessage: "继续修复另一个 bug",
        peekSticky: () => completeSticky(),
      },
      expectedPeek: 1,
    },
    { name: "missing peek", options: { userMessage: "继续" }, expectedPeek: 0 },
    {
      name: "throwing peek",
      options: { userMessage: "继续", peekSticky: () => { throw new Error("unavailable"); } },
      expectedPeek: 1,
    },
    {
      name: "incomplete peek",
      options: {
        userMessage: "继续",
        peekSticky: () => ({ previousTier: "full", orchestrating: false }),
      },
      expectedPeek: 1,
    },
    {
      name: "subagent",
      options: { userMessage: "继续", isSubagent: true, peekSticky: () => completeSticky() },
      expectedPeek: 0,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const result = await runHarness(item.options);
      assert.equal(result.peekCount, item.expectedPeek);
      assert.equal(result.invalidateCount, 1);
      assert.equal(result.metadata[0]?.continuation, undefined);
    });
  }
});

test("task snapshot maps only approved facts and degrades locally", async (t) => {
  await t.test("maps plan todos and five recent files without diagnostics leakage", async () => {
    const result = await runHarness({
      planSnapshot: {
        approvedPlan: "  approved plan  ",
        requiresInitialization: true,
        lastMarkdown: "secret markdown",
        todoHistory: [{ markdown: "history" }],
        todos: [
          { content: "  first task  ", status: "in_progress", priority: "high" },
          { content: "   ", status: "completed", priority: "low" },
        ],
        todoDiagnostics: { activeCount: 1 },
      },
      recentFiles: ["a.ts", 42, "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
    });
    const snapshot = result.metadata[0]?.taskSnapshot;
    assert.deepEqual(snapshot, {
      approvedPlan: "  approved plan  ",
      requiresInitialization: true,
      todos: [{ content: "first task", status: "in_progress" }],
      activeTodoCount: 1,
      allCompleted: false,
      keyFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /lastMarkdown|todoHistory|priority|secret markdown/);
  });

  await t.test("keeps key files when todo lookup fails", async () => {
    const result = await runHarness({
      planSnapshot: () => { throw new Error("todo unavailable"); },
      recentFiles: ["only.ts"],
    });
    assert.deepEqual(result.metadata[0]?.taskSnapshot, {
      requiresInitialization: false,
      todos: [],
      activeTodoCount: 0,
      allCompleted: false,
      keyFiles: ["only.ts"],
    });
  });

  await t.test("omits empty facts when file history fails", async () => {
    const result = await runHarness({
      planSnapshot: {
        requiresInitialization: false,
        todos: [],
        todoDiagnostics: { activeCount: 0 },
      },
      recentFiles: () => { throw new Error("history unavailable"); },
    });
    assert.equal(result.metadata[0]?.taskSnapshot, undefined);
  });
});

test("upgrade evidence is prioritized and dynamic tool failures affect later decisions", async (t) => {
  await t.test("todo expansion outranks a high reliability request", async () => {
    const result = await runHarness({
      userMessage: "Make this production ready",
      planSnapshot: {
        requiresInitialization: false,
        todos: [{ content: "new work", status: "pending" }],
        todoDiagnostics: {
          activeCount: 1,
          lastWrite: { addedCount: 1, allCompleted: false },
        },
      },
    });
    assert.equal(result.metadata[0]?.upgradeEvidence, "todo_expanded");
  });

  await t.test("repeated tool errors appear on the next decide", async () => {
    const calls = [
      { id: "repeat-1", name: "bash", input: { command: "echo one" } },
      { id: "repeat-2", name: "bash", input: { command: "echo two" } },
    ];
    const result = await runHarness({
      scripts: [toolResponse(calls), finalResponse("done")],
      toolResults: [[errorResult(calls[0]!), errorResult(calls[1]!)]],
    });
    assert.equal(result.metadata[0]?.upgradeEvidence, undefined);
    assert.equal(result.metadata[1]?.upgradeEvidence, "repeated_tool_error");
  });

  await t.test("failed verification outranks the original reliability request", async () => {
    const call = { id: "verify-1", name: "bash", input: { command: "npm run build" } };
    const result = await runHarness({
      userMessage: "Fully verify this change",
      scripts: [toolResponse([call]), finalResponse("done")],
      toolResults: [[errorResult(call)]],
    });
    assert.equal(result.metadata[0]?.upgradeEvidence, "high_reliability_request");
    assert.equal(result.metadata[1]?.upgradeEvidence, "verification_failed");
  });

  await t.test("a failed non-verification command does not invent evidence", async () => {
    const call = { id: "normal-1", name: "bash", input: { command: "echo hello" } };
    const result = await runHarness({
      scripts: [toolResponse([call]), finalResponse("done")],
      toolResults: [[errorResult(call)]],
    });
    assert.equal(result.metadata[1]?.upgradeEvidence, undefined);
  });
});

test("model override reads static facts without calling router decide", async () => {
  const result = await runHarness({
    userMessage: "继续",
    peekSticky: () => completeSticky(),
    planSnapshot: {
      requiresInitialization: false,
      todos: [{ content: "work", status: "pending" }],
      todoDiagnostics: { activeCount: 1 },
    },
    modelOverride: { provider: "explicit-provider", model: "explicit-model" },
  });
  assert.equal(result.planSnapshotCount, 1);
  assert.equal(result.peekCount, 1);
  assert.equal(result.invalidateCount, 0);
  assert.equal(result.metadata.length, 0);
});

function completeSticky(): InvalidateStickyResult {
  return {
    previousTier: "full",
    previousProvider: "provider-a",
    previousModel: "model-a",
    orchestrating: false,
  };
}

function finalResponse(text: string): CanonicalModelEvent[] {
  return [
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text },
    { type: "message_end", finishReason: "stop" },
  ];
}

function toolResponse(toolCalls: CanonicalToolCall[]): CanonicalModelEvent[] {
  return [
    { type: "message_start", role: "assistant" },
    ...toolCalls.map((toolCall): CanonicalModelEvent => ({ type: "tool_call_end", toolCall })),
    { type: "message_end", finishReason: "stop" },
  ];
}

function successResult(call: CanonicalToolCall): PilotDeckToolResult {
  return {
    type: "success",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: "ok" }],
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:00:00.001Z",
  };
}

function errorResult(call: CanonicalToolCall): PilotDeckToolResult {
  return {
    type: "error",
    toolCallId: call.id,
    toolName: call.name,
    error: { code: "tool_execution_failed", message: "failed" },
    content: [{ type: "text", text: "failed" }],
    metadata: { recovery: { failureClass: "execution" } },
    startedAt: "2026-09-11T00:00:00.000Z",
    completedAt: "2026-09-11T00:00:00.001Z",
  };
}
