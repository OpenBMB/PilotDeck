import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createGroupMemberDelegateTool,
  type PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

function context(tokenPath: string, sessionId = "group:room-1:main"): PilotDeckToolRuntimeContext {
  return {
    sessionId,
    turnId: "turn-1",
    cwd: process.cwd(),
    env: { PILOTDECK_GATEWAY_TOKEN_PATH: tokenPath },
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

test("group_member_delegate calls the persistent room member and returns the real reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pilotdeck-group-delegate-"));
  const tokenPath = join(directory, "server-token");
  writeFileSync(tokenPath, "local-token\n");
  let request: { url: string; init?: RequestInit } | undefined;
  try {
    const tool = createGroupMemberDelegateTool({
      baseUrl: "http://127.0.0.1:3001",
      fetchImpl: (async (url, init) => {
        request = { url: String(url), init };
        return new Response(JSON.stringify({
          member: { id: "reviewer", name: "PilotDeck 评审员" },
          message: { id: "message-1", content: "我是独立评审智能体。" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });

    const result = await tool.execute(
      { memberId: "reviewer", message: "请介绍你的职责。" },
      context(tokenPath),
    );

    assert.equal(request?.url, "http://127.0.0.1:3001/api/groups/room-1/delegate");
    assert.equal((request?.init?.headers as Record<string, string>)["X-PilotDeck-Group-Token"], "local-token");
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
      sourceSessionId: "group:room-1:main",
      sourceTurnId: "turn-1",
      memberId: "reviewer",
      message: "请介绍你的职责。",
    });
    assert.equal(result.data?.reply, "我是独立评审智能体。");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("group_member_delegate rejects non-main sessions before making a request", async () => {
  const tool = createGroupMemberDelegateTool({
    fetchImpl: (async () => assert.fail("unexpected request")) as typeof fetch,
  });
  await assert.rejects(
    tool.execute({ memberId: "reviewer", message: "hello" }, context("unused", "group:room-1:reviewer")),
    /only available to the main agent/u,
  );
});
