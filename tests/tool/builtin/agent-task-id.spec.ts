import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAskModeAgentToolSchema,
  createAgentTool,
  type AgentToolOutput,
} from "../../../src/tool/builtin/agent.js";
import { PilotDeckToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type {
  PilotDeckSubagentForkApi,
  PilotDeckToolModelClient,
  PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";

const FINAL_REPORT = [
  "Scope: test",
  "Result: ok",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

const DEFINITION_IDS = ["general-purpose", "explore", "plan", "verify"];

function baseContext(
  fork: PilotDeckSubagentForkApi | undefined,
  overrides: Partial<PilotDeckToolRuntimeContext> = {},
): PilotDeckToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    ...(fork ? { subagent: fork } : {}),
    ...overrides,
  };
}

type RecordedForkCall = Parameters<PilotDeckSubagentForkApi["fork"]>[0];

function recordingFork(
  calls: RecordedForkCall[],
  options: { hangOnTaskId?: boolean; gate?: Promise<void> } = {},
): PilotDeckSubagentForkApi {
  return {
    depth: 0,
    maxSubagentDepth: 1,
    supportsContinuation: true,
    listDefinitions: () => DEFINITION_IDS.map((id) => ({ id, description: id })),
    isAllowedDefinition: (id) => DEFINITION_IDS.includes(id),
    fork: async (args) => {
      calls.push(args);
      if (options.hangOnTaskId && args.taskId) {
        await (options.gate ?? new Promise<void>(() => {}));
      }
      return {
        markdown: FINAL_REPORT,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        turns: 1,
        durationMs: 1,
        parsed: undefined,
        subagentId: args.taskId ?? args.subagentId,
        definitionId: args.definitionId ?? "general-purpose",
      };
    },
  };
}

test("agent tool schemas expose task_id in normal and ask mode", () => {
  const normal = createAgentTool();
  assert.equal(
    (normal.inputSchema.properties as Record<string, unknown>).task_id !== undefined,
    true,
    "normal schema must accept task_id",
  );

  const ask = buildAskModeAgentToolSchema();
  assert.equal(
    (ask.inputSchema.properties as Record<string, unknown>).task_id !== undefined,
    true,
    "ask-mode schema must accept task_id",
  );
});

test("new fork returns task_id in model-visible text and JSON output", async () => {
  const calls: RecordedForkCall[] = [];
  const tool = createAgentTool();
  const result = await tool.execute(
    { description: "inspect code", prompt: "inspect" },
    baseContext(recordingFork(calls)),
  );

  const output = result.data as AgentToolOutput;
  const freshTaskId = calls[0]!.subagentId!;
  assert.ok(freshTaskId, "fork must receive a generated subagent id");
  assert.equal(output.taskId, freshTaskId);

  const textBlock = result.content.find((block) => block.type === "text");
  assert.ok(textBlock && textBlock.type === "text");
  assert.match(textBlock.text, new RegExp(`task_id: ${freshTaskId}`));

  const jsonBlock = result.content.find((block) => block.type === "json");
  assert.ok(jsonBlock && jsonBlock.type === "json");
  assert.equal((jsonBlock.value as AgentToolOutput).taskId, freshTaskId);
});

test("task_id is rejected by the legacy single-shot runtime without any model call", async () => {
  const requests: CanonicalModelRequest[] = [];
  const model: PilotDeckToolModelClient = {
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", text: "should never stream" };
    },
  };
  const tool = createAgentTool({ model });

  await assert.rejects(
    tool.execute(
      { description: "d", prompt: "p", task_id: "some-task" },
      baseContext(undefined),
    ),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError
      && error.code === "unsupported_tool"
      && /task_id/.test(error.message),
  );
  assert.deepEqual(requests, [], "legacy fallback must not reach the model for task_id input");
});

test("simultaneous continuation of the same task fails busy and the guard is released afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: RecordedForkCall[] = [];
  const tool = createAgentTool();
  const context = baseContext(recordingFork(calls, { hangOnTaskId: true, gate }));

  const first = tool.execute(
    { description: "d", prompt: "p", task_id: "task-busy-1" },
    context,
  );
  // The guard is acquired synchronously before the first await, so a second
  // execute issued immediately must fail without reaching the fork.
  await assert.rejects(
    tool.execute(
      { description: "d", prompt: "p", task_id: "task-busy-1" },
      context,
    ),
    (error: unknown) =>
      error instanceof PilotDeckToolRuntimeError
      && error.details?.errorCode === "subagent_task_busy",
  );
  assert.equal(calls.length, 1, "busy continuation must not reach the fork a second time");

  release();
  const firstResult = (await first).data as AgentToolOutput;
  assert.equal(firstResult.taskId, "task-busy-1");

  // Guard must be released in finally — a follow-up continuation succeeds.
  const followup = await tool.execute(
    { description: "d", prompt: "p", task_id: "task-busy-1" },
    context,
  );
  assert.equal((followup.data as AgentToolOutput).taskId, "task-busy-1");
  assert.equal(calls.length, 2);
});

test("continuation without subagent_type forwards no definition so the saved identity is reused", async () => {
  const calls: RecordedForkCall[] = [];
  const tool = createAgentTool();

  await tool.execute(
    { description: "d", prompt: "next step", task_id: "task-9" },
    baseContext(recordingFork(calls)),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.taskId, "task-9");
  assert.equal(calls[0]!.definitionId, undefined);
});

test("continuation with an explicit type forwards it for a conflict check", async () => {
  const calls: RecordedForkCall[] = [];
  const tool = createAgentTool();

  await tool.execute(
    { description: "d", prompt: "next step", task_id: "task-10", subagent_type: "plan" },
    baseContext(recordingFork(calls)),
  );

  assert.equal(calls[0]!.taskId, "task-10");
  assert.equal(calls[0]!.definitionId, "plan");
});

test("continuation does not remap an omitted type in ask mode", async () => {
  const calls: RecordedForkCall[] = [];
  const tool = createAgentTool();

  await tool.execute(
    { description: "d", prompt: "next step", task_id: "task-11" },
    baseContext(recordingFork(calls), { runMode: "ask" }),
  );

  assert.equal(calls[0]!.definitionId, undefined, "saved identity must decide, not ask-mode remapping");
});

for (const taskId of ["", "  ", "child/id", "child\\id", "../child", "x".repeat(257)]) {
  test(`invalid task_id ${JSON.stringify(taskId.slice(0, 20))} does not launch a new child`, async () => {
    const calls: RecordedForkCall[] = [];
    await assert.rejects(createAgentTool().execute({ description: "continue", prompt: "follow up", task_id: taskId }, baseContext(recordingFork(calls))),
      (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "invalid_tool_input");
    assert.equal(calls.length, 0);
  });
}

test("continuing a task in one parent does not block validation in another parent", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: RecordedForkCall[] = [];
  const tool = createAgentTool();
  const first = tool.execute({ description: "first", prompt: "continue", task_id: "same-id" }, baseContext(recordingFork(calls, { hangOnTaskId: true, gate })));
  try {
    await tool.execute({ description: "second", prompt: "continue", task_id: "same-id" }, baseContext(recordingFork(calls), { sessionId: "other-parent" }));
    assert.equal(calls.length, 2, "the runtime must get to validate the second parent's own storage");
  } finally {
    release();
    await first;
  }
});

for (const taskId of [42, null, {}]) {
  test(`non-string task_id ${JSON.stringify(taskId)} is an input error`, async () => {
    const calls: RecordedForkCall[] = [];
    await assert.rejects(createAgentTool().execute({ description: "continue", prompt: "follow up", task_id: taskId as unknown as string }, baseContext(recordingFork(calls))),
      (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "invalid_tool_input");
    assert.equal(calls.length, 0);
  });
}

test("a host without continuation support does not advertise a resumable task id", async () => {
  const fork = recordingFork([]);
  delete fork.supportsContinuation;
  const result = await createAgentTool().execute({ description: "new", prompt: "work" }, baseContext(fork));
  assert.equal(result.data?.taskId, undefined);
  assert.doesNotMatch(JSON.stringify(result.content), /task_id:/);
});

test("a legacy full-fork host cannot silently treat task_id as a fresh child", async () => {
  const calls: RecordedForkCall[] = [];
  const fork = recordingFork(calls);
  delete fork.supportsContinuation;
  await assert.rejects(createAgentTool().execute({ description: "continue", prompt: "follow up", task_id: "known-id" }, baseContext(fork)),
    (error: unknown) => error instanceof PilotDeckToolRuntimeError && error.code === "unsupported_tool");
  assert.equal(calls.length, 0);
});
