import test from "node:test";
import assert from "node:assert/strict";

import {
  createAgentTool,
  withBuiltinAgentToolDescription,
} from "../../../src/tool/builtin/agent.js";
import type {
  PilotDeckSubagentForkApi,
  PilotDeckToolModelClient,
  PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

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

function createFork(calls: string[]): PilotDeckSubagentForkApi {
  return {
    depth: 0,
    maxSubagentDepth: 1,
    listDefinitions: () => [
      { id: "general-purpose", description: "general" },
      { id: "explore", description: "explore" },
      { id: "plan", description: "plan" },
      { id: "verify", description: "verify" },
    ],
    isAllowedDefinition: (id) => ["general-purpose", "explore", "plan", "verify"].includes(id),
    fork: async ({ definitionId }) => {
      calls.push(definitionId);
      return {
        markdown: "Scope: test\nResult: ok\nKey files: none\nFiles changed: none\nIssues: none",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        turns: 1,
        durationMs: 1,
        parsed: undefined,
      };
    },
  };
}

test("agent tool accepts explorer as an alias for explore", async () => {
  const calls: string[] = [];
  const tool = createAgentTool();
  const result = await tool.execute(
    { description: "inspect code", prompt: "inspect", subagent_type: "explorer" },
    baseContext(createFork(calls)),
  );

  assert.equal(result.data?.subagentType, "explore");
  assert.deepEqual(calls, ["explore"]);
});

test("agent tool defaults general-purpose to explore in ask mode", async () => {
  const calls: string[] = [];
  const tool = createAgentTool();
  const result = await tool.execute(
    { description: "inspect code", prompt: "inspect" },
    baseContext(createFork(calls), { runMode: "ask" }),
  );

  assert.equal(result.data?.subagentType, "explore");
  assert.deepEqual(calls, ["explore"]);
});

test("agent description accounts for the caller depth when describing child tools", () => {
  const root = createAgentTool({ maxSubagentDepth: 3, subagentDepth: 0 });
  const lastFork = createAgentTool({ maxSubagentDepth: 3, subagentDepth: 2 });

  assert.match(root.description, /nested delegation is available within the configured depth cap/);
  assert.match(lastFork.description, /except nested agent launch/);
});

test("native agent description adaptation preserves execute and schema references", () => {
  const original = createAgentTool();
  const described = withBuiltinAgentToolDescription(original, { maxSubagentDepth: 2 });

  assert.ok(described);
  assert.notEqual(described, original);
  assert.equal(described.execute, original.execute);
  assert.equal(described.inputSchema, original.inputSchema);
  assert.match(described.description, /nested delegation is available within the configured depth cap/);
});

test("agent tool keeps host-owned one-shot sidechain references in its result", async () => {
  const tool = createAgentTool();
  const result = await tool.execute(
    { description: "inspect transcript", prompt: "inspect", subagent_type: "explore" },
    baseContext({
      depth: 0,
      maxSubagentDepth: 1,
      listDefinitions: () => [{ id: "explore", description: "explore" }],
      isAllowedDefinition: (id) => id === "explore",
      fork: async () => ({
        markdown: "Scope: test\nResult: ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        turns: 1,
        durationMs: 1,
        subagentSessionId: "parent::sub::child-1",
        transcriptRelativePath: "sessions/parent/subagents/child-1.jsonl",
      }),
    }),
  );

  assert.equal(result.data?.subagentSessionId, "parent::sub::child-1");
  assert.equal(result.data?.transcriptRelativePath, "sessions/parent/subagents/child-1.jsonl");
  assert.equal(result.metadata?.subagentSessionId, "parent::sub::child-1");
  assert.equal(result.metadata?.transcriptRelativePath, "sessions/parent/subagents/child-1.jsonl");
});

test("agent tool uses the host-provided subagent identity source", async () => {
  let receivedSubagentId: string | undefined;
  const tool = createAgentTool({ uuid: () => "deterministic-child" });
  const result = await tool.execute(
    { description: "inspect identity", prompt: "inspect", subagent_type: "explore" },
    baseContext({
      depth: 0,
      maxSubagentDepth: 1,
      listDefinitions: () => [{ id: "explore", description: "explore" }],
      isAllowedDefinition: (id) => id === "explore",
      fork: async ({ subagentId }) => {
        receivedSubagentId = subagentId;
        return {
          markdown: "Scope: test\nResult: ok",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          turns: 1,
          durationMs: 1,
        };
      },
    }),
  );

  assert.equal(receivedSubagentId, "deterministic-child");
  assert.equal(result.metadata?.subagentId, "deterministic-child");
});

test("agent tool preserves unknown custom fallback subagent names", async () => {
  const requests: string[] = [];
  const model: PilotDeckToolModelClient = {
    async *stream(request) {
      requests.push(String(request.metadata?.subagent));
      yield { type: "text_delta", text: "custom ok" };
    },
  };
  const tool = createAgentTool({
    model,
    subagents: {
      CustomAgent: {
        type: "general-purpose",
        description: "custom",
        systemPrompt: "custom",
      },
    },
  });

  const result = await tool.execute(
    { description: "custom run", prompt: "run", subagent_type: " CustomAgent " },
    {
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
    },
  );

  assert.equal(result.data?.subagentType, "CustomAgent");
  assert.deepEqual(requests, ["general-purpose"]);
});
