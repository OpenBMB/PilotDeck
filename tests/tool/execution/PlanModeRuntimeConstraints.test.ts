import assert from "node:assert/strict";
import test from "node:test";

import { PermissionRuntime, createDefaultPermissionContext } from "../../../src/permission/index.js";
import {
  ToolRuntime,
  ToolRegistry,
  createBashTool,
  createEditFileTool,
  createExitPlanModeTool,
  createWriteFileTool,
  type PilotDeckToolDefinition,
  type PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";

test("plan mode blocks tools outside the runtime allowlist before execution", async () => {
  const registry = new ToolRegistry();
  let executed = false;
  registry.register({
    name: "edit_notebook",
    description: "Notebook edit test tool.",
    kind: "filesystem",
    inputSchema: { type: "object", additionalProperties: true },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "should not run" }] };
    },
  });

  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    { id: "call-1", name: "edit_notebook", input: {} },
    createPlanContext(),
  );

  assert.equal(executed, false);
  assert.equal(result.type, "error");
  if (result.type !== "error") return;
  assert.equal(result.error.code, "plan_mode_violation");
  assert.match(textOf(result), /edit_notebook/);
});

test("plan mode blocks side-effecting bash commands without asking permission", async () => {
  const registry = new ToolRegistry();
  registry.register(createBashTool({
    runner: {
      async run() {
        throw new Error("bash runner should not be reached");
      },
    },
  }));

  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    { id: "call-1", name: "bash", input: { command: "mkdir build-output" } },
    createPlanContext(),
  );

  assert.equal(result.type, "error");
  if (result.type !== "error") return;
  assert.equal(result.error.code, "plan_mode_violation");
  assert.match(textOf(result), /READ-ONLY commands/);
  assert.match(textOf(result), /mkdir build-output/);
});

test("plan mode blocks bash read-only classifier bypasses", async () => {
  const registry = new ToolRegistry();
  registry.register(createBashTool({
    runner: {
      async run() {
        throw new Error("bash runner should not be reached");
      },
    },
  }));

  const commands = [
    "echo hello > plan-output.txt",
    "printf hello >> plan-output.txt",
    "cat package.json | tee copied-package.json",
    "pwd; touch plan-output.txt",
    "node -e \"require('fs').writeFileSync('plan-output.txt', 'hello')\"",
    "node --eval=\"fs.appendFileSync('plan-output.txt', 'hello')\"",
  ];

  for (const command of commands) {
    const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
      { id: `call-${command}`, name: "bash", input: { command } },
      createPlanContext(),
    );

    assert.equal(result.type, "error", command);
    if (result.type !== "error") continue;
    assert.equal(result.error.code, "plan_mode_violation", command);
    assert.match(textOf(result), /READ-ONLY commands/, command);
  }
});

test("plan mode allows read-only bash commands", async () => {
  const registry = new ToolRegistry();
  let executedCommand: string | undefined;
  registry.register(createBashTool({
    runner: {
      async run(command) {
        executedCommand = command;
        return {
          stdout: "ok\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
        };
      },
    },
  }));

  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    { id: "call-1", name: "bash", input: { command: "git status --short" } },
    createPlanContext(),
  );

  assert.equal(result.type, "success");
  assert.equal(executedCommand, "git status --short");
});

test("plan mode blocks write_file outside .pilotdeck/plans before tool validation", async () => {
  const registry = new ToolRegistry();
  registry.register(createWriteFileTool());

  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    { id: "call-1", name: "write_file", input: { file_path: "src/change.ts" } },
    createPlanContext(),
  );

  assert.equal(result.type, "error");
  if (result.type !== "error") return;
  assert.equal(result.error.code, "plan_mode_violation");
  assert.match(textOf(result), /write_file/);
});

test("plan mode lets markdown plan writes reach the tool after preflight", async () => {
  const registry = new ToolRegistry();
  let executed = false;
  registry.register(createPlanWriteProbe("write_file", () => {
    executed = true;
  }));

  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    {
      id: "call-1",
      name: "write_file",
      input: { file_path: ".pilotdeck/plans/cache-stable.md", content: "# Plan\n" },
    },
    createPlanContext(),
  );

  assert.equal(result.type, "success");
  assert.equal(executed, true);
});

test("plan mode lets markdown plan edits reach the tool after preflight", async () => {
  const registry = new ToolRegistry();
  let executed = false;
  registry.register(createPlanWriteProbe("edit_file", () => {
    executed = true;
  }));

  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    {
      id: "call-1",
      name: "edit_file",
      input: {
        file_path: ".pilotdeck/plans/cache-stable.md",
        old_string: "old",
        new_string: "new",
      },
    },
    createPlanContext(),
  );

  assert.equal(result.type, "success");
  assert.equal(executed, true);
});

test("exit_plan_mode is runtime-gated outside plan mode", async () => {
  const registry = new ToolRegistry();
  registry.register(createExitPlanModeTool());

  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    { id: "call-1", name: "exit_plan_mode", input: { plan_file_path: ".pilotdeck/plans/cache-stable.md" } },
    createContext("default"),
  );

  assert.equal(result.type, "error");
  if (result.type !== "error") return;
  assert.equal(result.error.code, "tool_execution_failed");
  assert.match(textOf(result), /only be used while plan mode is active/);
});

function createPlanWriteProbe(
  name: "write_file" | "edit_file",
  onExecute: () => void,
): PilotDeckToolDefinition<Record<string, unknown>> {
  const schema = name === "write_file"
    ? createWriteFileTool().inputSchema
    : createEditFileTool().inputSchema;
  return {
    name,
    description: `${name} probe.`,
    kind: "filesystem",
    inputSchema: schema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => {
      onExecute();
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

function createPlanContext(): PilotDeckToolRuntimeContext {
  return {
    ...createContext("plan"),
    planDirectory: {
      path: "/workspace/.pilotdeck/plans",
      resolve: () => undefined,
      read: () => undefined,
    },
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace",
      mode: "plan",
      planDirectoryPath: "/workspace/.pilotdeck/plans",
    }),
  };
}

function createContext(
  permissionMode: PilotDeckToolRuntimeContext["permissionMode"],
): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd: "/workspace",
    permissionMode,
    permissionContext: createDefaultPermissionContext({ cwd: "/workspace", mode: permissionMode }),
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text ?? "" : "";
}
