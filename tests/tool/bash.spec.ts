import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { createBashTool } from "../../src/tool/builtin/bash.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import type { PilotDeckCommandRunner, PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

function createContext(): PilotDeckToolRuntimeContext {
  const cwd = "/tmp/workspace";
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false }),
  };
}

function createRuntime(runner: PilotDeckCommandRunner): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner, maxTimeoutMs: 600_000 }));
  return new ToolRuntime(registry, new PermissionRuntime());
}

describe("bash long-running guardrails", () => {
  it("rejects foreground timeout above the maximum", async () => {
    let ran = false;
    const runtime = createRuntime({
      run: async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
      },
    });

    const result = await runtime.execute({ id: "call-1", name: "bash", input: { command: "echo ok", timeout: 600_001 } }, createContext());

    assert.equal(result.type, "error");
    assert.equal(result.error.code, "invalid_tool_input");
    assert.match(result.error.message, /task_create/u);
    assert.equal(ran, false);
  });

  it("rejects long-lived and shell-backgrounded foreground commands", async () => {
    const runtime = createRuntime({
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }),
    });
    const commands = [
      "pnpm dev",
      "npm run dev",
      "vite --host 0.0.0.0",
      "python -m http.server 8000",
      "nohup node server.js &",
      "setsid node server.js",
      "node server.js &",
    ];

    for (const command of commands) {
      const result = await runtime.execute({ id: `call-${command}`, name: "bash", input: { command } }, createContext());
      assert.equal(result.type, "error", command);
      assert.equal(result.error.code, "invalid_tool_input", command);
      assert.match(result.error.message, /task_create/u, command);
      assert.match(result.error.message, /task_output/u, command);
    }
  });

  it("allows help commands and timeout exactly at the maximum", async () => {
    const seen: Array<{ command: string; timeoutMs: number }> = [];
    const runtime = createRuntime({
      run: async (command, options) => {
        seen.push({ command, timeoutMs: options.timeoutMs });
        return { exitCode: 0, stdout: "usage", stderr: "", timedOut: false, durationMs: 1 };
      },
    });

    const help = await runtime.execute({ id: "call-help", name: "bash", input: { command: "pnpm dev --help" } }, createContext());
    assert.equal(help.type, "success");

    const max = await runtime.execute({ id: "call-max", name: "bash", input: { command: "echo ok", timeout: 600_000 } }, createContext());
    assert.equal(max.type, "success");
    assert.deepEqual(seen.map((item) => item.timeoutMs), [30_000, 600_000]);
  });
});
