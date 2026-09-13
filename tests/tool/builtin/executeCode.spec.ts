import assert from "node:assert/strict";
import test from "node:test";

import type { PilotDeckCommandRunner } from "../../../src/tool/builtin/bash/commandRunner.js";
import {
  createExecuteCodeTool,
  handleExecuteCodeRpcLineForTests,
} from "../../../src/tool/builtin/executeCode.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";

test("execute_code read-only probe handles missing input", () => {
  const tool = createExecuteCodeTool();

  assert.equal(tool.isReadOnly({} as never), false);
});

test("disabling web search removes it from the registry but keeps web fetch", () => {
  const registry = createBuiltinRegistry({ webSearch: false });

  assert.equal(registry.has("web_search"), false);
  assert.equal(registry.has("WebSearch"), false);
  assert.equal(registry.has("web_fetch"), true);
  assert.doesNotMatch(registry.get("execute_code")?.description ?? "", /\bweb_search\b/);
  assert.match(registry.get("execute_code")?.description ?? "", /\bweb_fetch\b/);
});

test("execute_code rejects nested web search calls when web search is disabled", async () => {
  let executed = false;
  const response = await handleExecuteCodeRpcLineForTests(
    JSON.stringify({ tool: "web_search", args: { query: "hello" } }),
    {
      webSearch: false,
      executeTool: async () => {
        executed = true;
        throw new Error("web_search should not be invoked");
      },
    },
  );

  assert.equal(response.code, "tool_not_allowed");
  assert.equal(executed, false);
});

test("execute_code helper allowlist removes filesystem-write and network bypasses", async () => {
  let executed = false;
  const options = {
    allowedTools: ["read_file", "grep", "glob", "bash"] as const,
    executeTool: async () => {
      executed = true;
      throw new Error("restricted helper must not execute");
    },
  };
  const write = await handleExecuteCodeRpcLineForTests(
    JSON.stringify({ tool: "write_file", args: { file_path: "blocked.txt", content: "blocked" } }),
    options,
  );
  const network = await handleExecuteCodeRpcLineForTests(
    JSON.stringify({ tool: "web_fetch", args: { url: "https://example.com" } }),
    options,
  );
  const tool = createExecuteCodeTool({ allowedTools: options.allowedTools });

  assert.equal(write.code, "tool_not_allowed");
  assert.equal(network.code, "tool_not_allowed");
  assert.equal(executed, false);
  assert.doesNotMatch(tool.description, /write_file|edit_file|web_fetch|web_search/);
  assert.match(tool.description, /read_file/);
});

test("execute_code strict empty helper allowlist denies raw RPC requests", async () => {
  let executed = false;
  const response = await handleExecuteCodeRpcLineForTests(
    JSON.stringify({ tool: "bash", args: { command: "id" } }),
    {
      allowedTools: [],
      executeTool: async () => {
        executed = true;
        throw new Error("strict host sandbox must not invoke nested tools");
      },
    },
  );
  const tool = createExecuteCodeTool({ allowedTools: [] });

  assert.equal(response.code, "tool_not_allowed");
  assert.equal(executed, false);
  assert.match(tool.description, /No PilotDeck helper RPC is available/);
  assert.doesNotMatch(tool.description, /Available helper functions:/);
});

test("execute_code routes Python through a host-owned runner without forwarding host environment", async () => {
  const calls: Array<{ command: string; options: Parameters<PilotDeckCommandRunner["run"]>[1] }> = [];
  const runner: PilotDeckCommandRunner = {
    async run(command, options) {
      calls.push({ command, options });
      return { exitCode: 0, stdout: "sandboxed python\n", stderr: "", timedOut: false, durationMs: 1 };
    },
  };
  const tool = createExecuteCodeTool({ runner });
  const context: PilotDeckToolRuntimeContext = {
    sessionId: "sandbox-session",
    turnId: "sandbox-turn",
    cwd: process.cwd(),
    env: { HOST_SECRET: "must-not-cross-the-boundary" },
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      rules: { allow: [], deny: [], ask: [] },
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
    },
    executeTool: async () => ({
      type: "success",
      toolCallId: "nested-tool",
      toolName: "read_file",
      content: [],
      data: {},
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }),
  };

  const result = await tool.execute({ code: "print('hello')" }, context);

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.command ?? "", /^python3 '.*script\.py'$/);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /sandboxed python/);
  assert.equal(calls[0]?.options.env?.HOST_SECRET, undefined);
  assert.equal(typeof calls[0]?.options.env?.PILOTDECK_RPC_SOCKET, "string");
  assert.equal(typeof calls[0]?.options.env?.PILOTDECK_EXECUTE_CODE_TEMP_ROOT, "string");
  assert.equal(typeof calls[0]?.options.env?.PYTHONPATH, "string");
  assert.match(tool.description, /not the Gateway process environment/);
  assert.doesNotMatch(tool.description, /including configured API/);
});
