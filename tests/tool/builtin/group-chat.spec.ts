import assert from "node:assert/strict";
import test from "node:test";

import { GroupChatRuntime } from "../../../src/collaboration/index.js";
import { createGroupChatTool } from "../../../src/tool/builtin/groupChat.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import type {
  PilotDeckSubagentForkApi,
  PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

function context(fork?: PilotDeckSubagentForkApi): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: process.cwd(),
    env: {},
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
  };
}

test("builtin registry exposes group_chat when a shared project runtime is configured", () => {
  const registry = createBuiltinRegistry({
    groupChat: { runtime: new GroupChatRuntime() },
    webSearch: false,
  });

  assert.equal(registry.has("group_chat"), true);
  assert.equal(registry.has("GroupChat"), true);
  assert.equal(registry.has("group_member_delegate"), true);
});

test("group_chat runs local PilotDeck and mock StaffDeck participants only when send_message is called", async () => {
  const directives: string[] = [];
  const fork: PilotDeckSubagentForkApi = {
    depth: 0,
    maxSubagentDepth: 1,
    listDefinitions: () => [{ id: "general-purpose", description: "general" }],
    isAllowedDefinition: (id) => id === "general-purpose",
    fork: async ({ directive }) => {
      directives.push(directive);
      const result = directive.includes("Mock Reviewer") ? "Mock review" : "Local plan";
      return {
        markdown: `Scope: group\nResult: ${result}\nKey files: none\nFiles changed: none\nIssues: none`,
        parsed: { Scope: "group", Result: result, "Key files": "none", "Files changed": "none", Issues: "none" },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        turns: 1,
        durationMs: 1,
      };
    },
  };
  const tool = createGroupChatTool({ runtime: new GroupChatRuntime() });
  const created = await tool.execute({
    action: "create_room",
    title: "Architecture review",
    participants: [
      { id: "architect", kind: "pilotdeck_local", name: "Architect", role: "design" },
      { id: "reviewer", kind: "staffdeck_mock", name: "Mock Reviewer", employeeId: "mock-reviewer" },
    ],
  }, context(fork));

  assert.equal(directives.length, 0);
  const roomId = created.data?.room?.id;
  assert.ok(roomId);
  const sent = await tool.execute({
    action: "send_message",
    roomId,
    message: "Propose and critique an MVP.",
  }, context(fork));

  assert.equal(directives.length, 2);
  assert.equal(sent.data?.replies?.length, 2);
  assert.deepEqual(sent.data?.replies?.map((reply) => reply.message?.content), ["Local plan", "Mock review"]);
  assert.match(sent.content[0]?.type === "text" ? sent.content[0].text : "", /Group chat round completed/u);
});

test("group_chat exposes mock employees without contacting StaffDeck when it is not configured", async () => {
  let fetched = false;
  const tool = createGroupChatTool({
    runtime: new GroupChatRuntime(),
    fetchImpl: (async () => {
      fetched = true;
      throw new Error("unexpected fetch");
    }) as typeof fetch,
  });

  const result = await tool.execute({ action: "list_staffdeck_employees" }, context());

  assert.equal(fetched, false);
  assert.equal(result.data?.employeeSource, "mock");
  assert.deepEqual(result.data?.employees?.map((employee) => employee.id), [
    "mock-researcher",
    "mock-engineer",
    "mock-reviewer",
  ]);
});
