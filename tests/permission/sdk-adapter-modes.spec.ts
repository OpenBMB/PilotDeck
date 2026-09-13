import assert from "node:assert/strict";
import test from "node:test";
import { PermissionRuntime, createDefaultPermissionContext } from "../../src/permission/index.js";
import { createBashTool, createMcpTool, createWriteFileTool, type PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

function context(options: {
  cwd: string;
  mode?: "default" | "bypassPermissions" | "plan";
  canPrompt?: boolean;
  acceptEdits?: boolean;
}): PilotDeckToolRuntimeContext {
  const mode = options.mode ?? "default";
  const permissionContext = createDefaultPermissionContext({
    cwd: options.cwd,
    mode,
    canPrompt: options.canPrompt ?? true,
    acceptEdits: options.acceptEdits,
  });
  return {
    sessionId: "sdk-session",
    turnId: "sdk-turn",
    cwd: options.cwd,
    permissionMode: mode,
    permissionContext,
  };
}

test("acceptEdits allows workspace file writes without broadening other tools", async () => {
  const runtime = new PermissionRuntime();
  const write = await runtime.decide(
    createWriteFileTool(),
    { file_path: "notes.txt", content: "hello" },
    context({ cwd: "/tmp/project", acceptEdits: true }),
    "write-1",
  );
  assert.equal(write.type, "allow");

  const bash = await runtime.decide(
    createBashTool(),
    { command: "echo hello > notes.txt" },
    context({ cwd: "/tmp/project", acceptEdits: true }),
    "bash-1",
  );
  assert.equal(bash.type, "ask");

  const mcp = await runtime.decide(
    createMcpTool({ serverId: "tickets", toolName: "create" }),
    {},
    context({ cwd: "/tmp/project", acceptEdits: true }),
    "mcp-1",
  );
  // MCP remains governed by its native read-only classification; the
  // acceptEdits adapter does not add a new MCP allow rule.
  assert.equal(mcp.type, "allow");
});

test("acceptEdits keeps outside-workspace writes behind the normal permission gate", async () => {
  const decision = await new PermissionRuntime().decide(
    createWriteFileTool(),
    { file_path: "/tmp/outside.txt", content: "hello" },
    context({ cwd: "/tmp/project", acceptEdits: true }),
    "write-outside",
  );
  assert.equal(decision.type, "ask");
});

test("dontAsk fails closed for an operation that would otherwise prompt", async () => {
  const decision = await new PermissionRuntime().decide(
    createBashTool(),
    { command: "echo hello > notes.txt" },
    context({ cwd: "/tmp/project", canPrompt: false }),
    "bash-headless",
  );
  assert.equal(decision.type, "deny");
  assert.match(decision.type === "deny" ? decision.message : "", /prompts are disabled/);
});
