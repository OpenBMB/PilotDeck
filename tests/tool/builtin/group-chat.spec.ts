import assert from "node:assert/strict";
import test from "node:test";

import { GroupChatRuntime } from "../../../src/collaboration/index.js";
import { createGroupChatTool } from "../../../src/tool/builtin/groupChat.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import type {
  PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

function context(): PilotDeckToolRuntimeContext {
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

test("group_chat rejects legacy local and Mock participants", async () => {
  const tool = createGroupChatTool({ runtime: new GroupChatRuntime() });
  await assert.rejects(
    tool.execute({
      action: "create_room",
      title: "Architecture review",
      participants: [
        { id: "architect", kind: "pilotdeck_local", name: "Architect", role: "design" },
      ],
    }, context()),
    /Only approved remote PilotDeck instances and real StaffDeck employees/u,
  );
  await assert.rejects(
    tool.execute({
      action: "create_room",
      title: "Mock review",
      participants: [
        { id: "reviewer", kind: "staffdeck_mock", name: "Mock Reviewer", employeeId: "mock-reviewer" },
      ],
    }, context()),
    /Only approved remote PilotDeck instances and real StaffDeck employees/u,
  );
});

test("group_chat requires real StaffDeck configuration instead of exposing Mock employees", async () => {
  let fetched = false;
  const tool = createGroupChatTool({
    runtime: new GroupChatRuntime(),
    fetchImpl: (async () => {
      fetched = true;
      throw new Error("unexpected fetch");
    }) as typeof fetch,
  });

  await assert.rejects(
    tool.execute({ action: "list_staffdeck_employees" }, context()),
    /StaffDeck access requires STAFFDECK_BASE_URL and STAFFDECK_API_KEY/u,
  );
  assert.equal(fetched, false);
});
