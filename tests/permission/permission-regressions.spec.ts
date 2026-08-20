import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultPermissionContext,
  PermissionRuntime,
  type PermissionResult,
} from "../../src/permission/index.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/index.js";

test("default and plan modes preserve their read/write boundary", async () => {
  const runtime = new PermissionRuntime();
  const read = tool("read_file", true, "filesystem");
  const write = tool("write_file", false, "filesystem");

  assert.equal((await runtime.decide(read, {}, context("default"), "read-default")).type, "allow");
  assert.equal((await runtime.decide(write, {}, context("default"), "write-default")).type, "ask");
  assert.equal((await runtime.decide(read, {}, context("plan"), "read-plan")).type, "allow");
  assert.equal((await runtime.decide(write, {}, context("plan"), "write-plan")).type, "deny");
});

test("plan mode permits markdown writes only inside its plan directory", async () => {
  const runtime = new PermissionRuntime();
  const write = tool("write_file", false, "filesystem");
  const runtimeContext = context("plan");
  runtimeContext.permissionContext.planDirectoryPath = "/tmp/project/.pilotdeck/plans";

  assert.equal((await runtime.decide(write, {
    filePath: "/tmp/project/.pilotdeck/plans/plan.md",
  }, runtimeContext, "allowed")).type, "allow");
  assert.equal((await runtime.decide(write, {
    filePath: "/tmp/project/README.md",
  }, runtimeContext, "outside")).type, "deny");
  assert.equal((await runtime.decide(write, {
    filePath: "/tmp/project/.pilotdeck/plans/plan.txt",
  }, runtimeContext, "non-markdown")).type, "deny");
});

test("deny rules beat bypass mode and ask rules beat allow rules", async () => {
  const runtime = new PermissionRuntime();
  const bash = tool("bash", false, "shell");
  const denied = context("bypassPermissions", {
    deny: [{ source: "project", behavior: "deny", toolName: "bash" }],
    allow: [{ source: "user", behavior: "allow", toolName: "bash" }],
  });
  const asked = context("default", {
    ask: [{ source: "project", behavior: "ask", toolName: "bash", pattern: "pwd:*" }],
    allow: [{ source: "user", behavior: "allow", toolName: "bash" }],
  });

  assert.equal((await runtime.decide(bash, {}, denied, "deny")).type, "deny");
  assert.equal((await runtime.decide(bash, { command: "pwd" }, asked, "ask")).type, "ask");
});

test("session grants override user denies but never project denies", async () => {
  const runtime = new PermissionRuntime();
  const bash = tool("bash", false, "shell");
  const rules = (source: "user" | "project") => ({
    deny: [{ source, behavior: "deny" as const, toolName: "bash", pattern: "pwd:*" }],
    allow: [{ source: "session" as const, behavior: "allow" as const, toolName: "bash", pattern: "pwd:*" }],
  });

  assert.equal((await runtime.decide(bash, { command: "pwd" }, context("bypassPermissions", rules("user")), "user")).type, "allow");
  assert.equal((await runtime.decide(bash, { command: "pwd" }, context("bypassPermissions", rules("project")), "project")).type, "deny");
});

test("tool safety denies cannot be bypassed by mode or session grants", async () => {
  const safetyDeny: PermissionResult = {
    type: "deny",
    reason: { type: "safety", message: "dangerous command" },
    message: "dangerous command",
  };
  const bash = tool("bash", false, "shell", safetyDeny);
  const runtime = new PermissionRuntime();
  const granted = context("bypassPermissions", {
    allow: [{ source: "session", behavior: "allow", toolName: "bash" }],
  });

  assert.equal((await runtime.decide(bash, {}, context("bypassPermissions"), "mode")).type, "deny");
  assert.equal((await runtime.decide(bash, {}, granted, "session")).type, "deny");
});

test("bypass mode overrides a tool-level ask", async () => {
  const runtime = new PermissionRuntime();
  const search = tool("web_search", true, "network", askPermission("web_search"));

  assert.equal((await runtime.decide(search, {}, context("bypassPermissions"), "search")).type, "allow");
});

test("plan mode allows read-only tool asks and denies side-effecting tool asks", async () => {
  const runtime = new PermissionRuntime();
  const read = tool("web_search", true, "network", askPermission("web_search"));
  const write = tool("bash", false, "shell", askPermission("bash"));

  assert.equal((await runtime.decide(read, {}, context("plan"), "read")).type, "allow");
  assert.equal((await runtime.decide(write, { command: "mkdir output" }, context("plan"), "write")).type, "deny");
});

test("an unpromptable context converts permission prompts into denials", async () => {
  const runtime = new PermissionRuntime();
  const runtimeContext = context("default");
  runtimeContext.permissionContext.canPrompt = false;
  assert.equal((await runtime.decide(tool("bash", false, "shell"), {}, runtimeContext, "bash")).type, "deny");
});

function context(
  mode: PilotDeckToolRuntimeContext["permissionMode"],
  rules: Parameters<typeof createDefaultPermissionContext>[0]["rules"] = {},
): PilotDeckToolRuntimeContext {
  const cwd = "/tmp/project";
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd,
    permissionMode: mode,
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode,
      canPrompt: true,
      bypassAvailable: true,
      rules,
    }),
  };
}

function tool(
  name: string,
  readOnly: boolean,
  kind: PilotDeckToolDefinition["kind"],
  permission?: PermissionResult,
): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => true,
    checkPermissions: permission ? async () => permission : undefined,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], data: {} }),
  };
}

function askPermission(toolName: string): PermissionResult {
  return {
    type: "ask",
    reason: { type: "tool", toolName, message: `${toolName} requires permission` },
    request: {
      toolCallId: "",
      toolName,
      inputSummary: toolName,
      reason: { type: "tool", toolName, message: `${toolName} requires permission` },
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    },
  };
}
