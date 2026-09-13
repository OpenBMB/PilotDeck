import test from "node:test";
import assert from "node:assert/strict";

import { buildAskModeAgentToolSchema, createAgentTool, type AgentBackgroundOutput } from "../../../src/tool/builtin/agent.js";
import type {
  PilotDeckSubagentForkApi,
  PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

type StartBackgroundCall = {
  definitionId: string;
  directive: string;
  description: string;
  subagentId: string;
};

function baseContext(
  fork: PilotDeckSubagentForkApi,
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
    subagent: fork,
    ...overrides,
  };
}

function forkFixture(options: {
  startBackground?: (call: StartBackgroundCall) => Promise<{ taskId: string; subagentId: string; subagentType: string }>;
  forkCalled?: string[];
}): PilotDeckSubagentForkApi {
  return {
    depth: 0,
    maxSubagentDepth: 1,
    listDefinitions: () => [
      { id: "general-purpose", description: "general" },
      { id: "explore", description: "explore" },
    ],
    isAllowedDefinition: (id) => ["general-purpose", "explore"].includes(id),
    fork: async ({ definitionId }) => {
      options.forkCalled?.push(definitionId);
      return {
        markdown: "sync report",
        usage: {},
        turns: 1,
        durationMs: 1,
      };
    },
    ...(options.startBackground ? { startBackground: options.startBackground } : {}),
  };
}

test("run_in_background queues via startBackground and returns visible task instructions", async () => {
  const calls: StartBackgroundCall[] = [];
  const tool = createAgentTool();
  const result = await tool.execute(
    {
      description: "probe child",
      prompt: "wait for the gate",
      run_in_background: true,
    },
    baseContext(
      forkFixture({
        startBackground: async (call) => {
          calls.push(call);
          return { taskId: call.subagentId, subagentId: call.subagentId, subagentType: call.definitionId };
        },
      }),
    ),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.definitionId, "general-purpose");
  assert.equal(calls[0]?.description, "probe child");
  const text = result.content.find((block) => block.type === "text");
  assert.match(text && "text" in text ? text.text : "", /taskId=/);
  assert.match(text && "text" in text ? text.text : "", /task_output/);
  assert.match(text && "text" in text ? text.text : "", /task_stop/);
  const backgroundData = result.data as AgentBackgroundOutput;
  assert.equal(backgroundData.taskId, backgroundData.subagentId);
  assert.equal(backgroundData.runInBackground, true);
  assert.equal(result.metadata?.forkMode, "background");
});

test("run_in_background validates the subagent type BEFORE queueing", async () => {
  const calls: StartBackgroundCall[] = [];
  const tool = createAgentTool();
  await assert.rejects(
    () =>
      tool.execute(
        { description: "x", prompt: "y", subagent_type: "bogus", run_in_background: true },
        baseContext(
          forkFixture({
            startBackground: async (call) => {
              calls.push(call);
              return { taskId: call.subagentId, subagentId: call.subagentId, subagentType: call.definitionId };
            },
          }),
        ),
      ),
    /Unknown subagent_type/,
  );
  assert.equal(calls.length, 0);
});

test("run_in_background rejects nested forks BEFORE queueing", async () => {
  const calls: StartBackgroundCall[] = [];
  const tool = createAgentTool();
  await assert.rejects(
    () =>
      tool.execute(
        { description: "x", prompt: "y", run_in_background: true },
        baseContext(
          forkFixture({
            startBackground: async (call) => {
              calls.push(call);
              return { taskId: call.subagentId, subagentId: call.subagentId, subagentType: call.definitionId };
            },
          }),
          { subagentDepth: 1 },
        ),
      ),
    /subagent_depth_exceeded/,
  );
  assert.equal(calls.length, 0);
});

test("run_in_background without a background backend fails with unsupported_tool instead of running synchronously", async () => {
  const forkCalled: string[] = [];
  const tool = createAgentTool();
  await assert.rejects(
    () =>
      tool.execute(
        { description: "x", prompt: "y", run_in_background: true },
        baseContext(forkFixture({ forkCalled })),
      ),
    (error: unknown) => {
      const err = error as { code?: string; message?: string };
      return err.code === "unsupported_tool" && /run_in_background/.test(err.message ?? "");
    },
  );
  assert.deepEqual(forkCalled, []); // never silently ran synchronously
});

test("both normal and ask-mode agent schemas expose run_in_background", () => {
  const normal = createAgentTool().inputSchema;
  const ask = buildAskModeAgentToolSchema().inputSchema as {
    properties?: Record<string, unknown>;
  };
  assert.ok(
    normal.properties && "run_in_background" in normal.properties,
    "normal schema must expose run_in_background",
  );
  assert.ok(
    ask.properties && "run_in_background" in ask.properties,
    "ask schema must expose run_in_background",
  );
});
