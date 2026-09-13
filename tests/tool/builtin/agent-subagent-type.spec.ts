import test from "node:test";
import assert from "node:assert/strict";

import { createAgentTool } from "../../../src/tool/builtin/agent.js";
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

function createFork(calls: Array<string | undefined>): PilotDeckSubagentForkApi {
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
