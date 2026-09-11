import assert from "node:assert/strict";
import test from "node:test";

import { PermissionRuntime, createDefaultPermissionContext } from "../../src/permission/index.js";
import { createMcpTool } from "../../src/tool/builtin/mcpTool.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

function context(rules: Parameters<typeof createDefaultPermissionContext>[0]["rules"]): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/tmp/project",
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/tmp/project",
      mode: "bypassPermissions",
      canPrompt: true,
      rules,
    }),
  };
}

test("explicit SDK MCP ask override remains interactive in bypassPermissions", async () => {
  const tool = createMcpTool({ serverId: "tickets", toolName: "create_issue", adapter: { callTool: async () => ({ ok: true }) } });
  const runtime = new PermissionRuntime();
  const decision = await runtime.decide(tool, { title: "bug" }, context({
    ask: [{ source: "session", behavior: "ask", toolName: "mcp__tickets__*", force: true }],
  }), "call-1");

  assert.equal(decision.type, "ask");
  assert.equal(decision.type === "ask" ? decision.reason.type : undefined, "rule");
  assert.equal(decision.type === "ask" && decision.reason.type === "rule" ? decision.reason.rule.force : undefined, true);
});

test("native non-forced ask rules retain bypassPermissions allow behavior", async () => {
  const tool = createMcpTool({ serverId: "tickets", toolName: "create_issue", adapter: { callTool: async () => ({ ok: true }) } });
  const runtime = new PermissionRuntime();
  const decision = await runtime.decide(tool, { title: "bug" }, context({
    ask: [{ source: "project", behavior: "ask", toolName: "mcp__tickets__*" }],
  }), "call-2");

  assert.equal(decision.type, "allow");
  assert.equal(decision.type === "allow" ? decision.reason.type : undefined, "mode");
});

test("Gateway policy ask rules remain interactive in bypassPermissions", async () => {
  const tool = createMcpTool({ serverId: "tickets", toolName: "create_issue", adapter: { callTool: async () => ({ ok: true }) } });
  const runtime = new PermissionRuntime();
  const decision = await runtime.decide(tool, { title: "bug" }, context({
    ask: [{ source: "policy", behavior: "ask", toolName: "mcp__tickets__*" }],
  }), "call-policy-ask");

  assert.equal(decision.type, "ask");
  assert.equal(decision.type === "ask" && decision.reason.type === "rule" ? decision.reason.rule.source : undefined, "policy");
});

test("Gateway policy prompt disablement cannot be bypassed", async () => {
  const tool = createMcpTool({ serverId: "tickets", toolName: "create_issue", adapter: { callTool: async () => ({ ok: true }) } });
  const runtime = new PermissionRuntime();
  const runtimeContext = context({
    ask: [{ source: "policy", behavior: "ask", toolName: "mcp__tickets__*" }],
  });
  runtimeContext.permissionContext.policyCanPrompt = false;
  runtimeContext.permissionContext.canPrompt = false;

  const decision = await runtime.decide(tool, { title: "bug" }, runtimeContext, "call-policy-no-prompt");
  assert.equal(decision.type, "deny");
  assert.match(decision.type === "deny" ? decision.message : "", /Gateway policy disables prompts/);
});

test("force does not broaden native non-session permission rules", async () => {
  const tool = createMcpTool({ serverId: "tickets", toolName: "create_issue", adapter: { callTool: async () => ({ ok: true }) } });
  const runtime = new PermissionRuntime();
  const decision = await runtime.decide(tool, { title: "bug" }, context({
    ask: [{ source: "project", behavior: "ask", toolName: "mcp__tickets__*", force: true }],
  }), "call-3");

  assert.equal(decision.type, "allow");
});
