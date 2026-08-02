import assert from "node:assert/strict";
import test from "node:test";

import {
  createGroupMemberDelegateTool,
  type PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

function context(overrides: Record<string, unknown> = {}): PilotDeckToolRuntimeContext {
  return {
    sessionId: "group:room-1:entry-alice",
    turnId: "turn-1",
    cwd: process.cwd(),
    env: {},
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
    metadata: {
      collaboration: {
        version: 1,
        kind: "group_turn",
        roomId: "room-1",
        turnId: "turn-1",
        entryMemberId: "entry-alice",
        canDelegate: true,
        coordinatorUrl: "http://127.0.0.1:3001",
        delegationToken: "scoped-token",
        ...overrides,
      },
    },
  };
}

test("group_member_delegate uses the scoped grant and returns the real reply", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const tool = createGroupMemberDelegateTool({
    fetchImpl: (async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        member: { id: "reviewer", name: "PilotDeck 评审员" },
        message: { id: "message-1", content: "我是独立评审智能体。" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });

  const result = await tool.execute({ memberId: "reviewer", message: "请介绍你的职责。" }, context());

  assert.equal(request?.url, "http://127.0.0.1:3001/api/groups/room-1/delegate");
  assert.equal((request?.init?.headers as Record<string, string>)["X-PilotDeck-Delegation-Token"], "scoped-token");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    sourceSessionId: "group:room-1:entry-alice",
    sourceTurnId: "turn-1",
    memberId: "reviewer",
    message: "请介绍你的职责。",
  });
  assert.equal(result.data?.reply, "我是独立评审智能体。");
});

test("group_member_delegate rejects secondary turns without delegation authority", async () => {
  const tool = createGroupMemberDelegateTool({
    fetchImpl: (async () => assert.fail("unexpected request")) as typeof fetch,
  });
  await assert.rejects(
    tool.execute({ memberId: "reviewer", message: "hello" }, context({ canDelegate: false })),
    /only available to the current entry agent/u,
  );
});

test("group_member_delegate rejects a missing scoped token", async () => {
  const tool = createGroupMemberDelegateTool({
    fetchImpl: (async () => assert.fail("unexpected request")) as typeof fetch,
  });
  await assert.rejects(
    tool.execute({ memberId: "reviewer", message: "hello" }, context({ delegationToken: "" })),
    /scoped delegation token/u,
  );
});
