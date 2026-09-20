import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PilotDeckCommandRunner } from "../../../src/tool/builtin/bash/commandRunner.js";
import {
  createExecuteCodeTool,
  handleExecuteCodeRpcLineForTests,
} from "../../../src/tool/builtin/executeCode.js";
import type { ExecutionWorkspacePort } from "../../../src/tool/execution-world/ExecutionWorkspacePort.js";
import type { CodeRuntimePort } from "../../../src/tool/execution-world/CodeRuntimePort.js";
import type {
  ExecutionRpcTransport,
  ExecutionTransportPort,
} from "../../../src/tool/execution-world/ExecutionTransportPort.js";
import type { SandboxPort } from "../../../src/tool/execution-world/SandboxPort.js";
import { createNodeSandboxPort } from "../../../src/tool/execution-world/NodeSandboxPort.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

function context(): PilotDeckToolRuntimeContext {
  return {
    sessionId: "execute-code-session",
    turnId: "execute-code-turn",
    currentToolCallId: "execute-code-call",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
    executeTool: async (call) => ({
      type: "success",
      toolCallId: call.id,
      toolName: call.name,
      startedAt: "2026-09-09T00:00:00.000Z",
      completedAt: "2026-09-09T00:00:00.000Z",
      content: [],
    }),
  };
}

test("execute_code read-only probe handles missing input", () => {
  const tool = createExecuteCodeTool();

  assert.equal(tool.isReadOnly({} as never), false);
});

test("execute_code describes native environment inheritance by sandbox mode", () => {
  const sandbox = {
    port: { async prepare(request: Parameters<SandboxPort["prepare"]>[0]) { return request; } },
    resolvePolicy: ({ workspaceRoot, executionRoot }: { workspaceRoot: string; executionRoot: string }) => ({
      mode: "danger-full-access" as const,
      workspaceRoot,
      executionRoot,
    }),
  };

  assert.match(createExecuteCodeTool({ sandbox: { ...sandbox, mode: "danger-full-access" } }).description, /inherits the same runtime environment/);
  assert.match(createExecuteCodeTool({ sandbox: { ...sandbox, mode: "read-only" } }).description, /read-only file-effect policy/);
  assert.match(createExecuteCodeTool({ sandbox }).description, /environment visibility is provider-defined/);
});

test("execute_code default host path preserves harmless parent environment sentinels", async () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const result = await createExecuteCodeTool({
    codeRuntime: {
      async resolveExecutable() { return "python3"; },
      async run(request) {
        capturedEnv = request.env;
        return { exitCode: 0, exitSignal: null, stdout: "sentinel", stderr: "", timedOut: false, cancelled: false };
      },
    },
    sandbox: {
      mode: "danger-full-access",
      port: { async prepare(request) { return request; } },
      resolvePolicy: ({ workspaceRoot, executionRoot }) => ({ mode: "danger-full-access" as const, workspaceRoot, executionRoot }),
    },
  }).execute({ code: "print('sentinel')" }, { ...context(), env: { PILOTDECK_TEST_SENTINEL: "pilotdeck-sentinel" } });

  assert.equal(result.data?.status, "success");
  assert.equal(capturedEnv?.PILOTDECK_TEST_SENTINEL, "pilotdeck-sentinel");
  assert.match(capturedEnv?.PYTHONPATH ?? "", /pilotdeck_execute_code_/);
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

test("execute_code consumes its injected execution workspace and cleans it after Python startup failure", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  let cleanupCalls = 0;
  const workspace: ExecutionWorkspacePort = {
    async create() {
      return {
        root: "/definitely-missing-pilotdeck-execution-workspace",
        async writeText(filePath, content) {
          writes.push({ path: filePath, content });
          return `/definitely-missing-pilotdeck-execution-workspace/${filePath}`;
        },
        async cleanup() {
          cleanupCalls += 1;
        },
      };
    },
  };

  const result = await createExecuteCodeTool({ executionWorkspace: workspace }).execute(
    { code: "print('never reaches this script')" },
    context(),
  );

  assert.equal(result.data?.status, "error");
  assert.deepEqual(writes.map((entry) => entry.path), ["pilotdeck_tools.py", "script.py"]);
  assert.equal(cleanupCalls, 1);
});

test("native execution workspace is cleaned after a successful execute_code run", async () => {
  const result = await createExecuteCodeTool().execute(
    { code: "import os\nprint(os.environ['PILOTDECK_EXECUTE_CODE_TEMP_ROOT'])" },
    context(),
  );

  assert.equal(result.data?.status, "success");
  const executionRoot = result.data?.output.trim();
  assert.ok(executionRoot);
  await assert.rejects(access(executionRoot));
});

test("execute_code consumes an injected code runtime while retaining Python RPC ownership", async () => {
  const requests: Array<Parameters<CodeRuntimePort["run"]>[0]> = [];
  const codeRuntime: CodeRuntimePort = {
    async resolveExecutable() {
      return "python3";
    },
    async run(request) {
      requests.push(request);
      return {
        exitCode: 0,
        exitSignal: null,
        stdout: "from fake runtime",
        stderr: "",
        timedOut: false,
        cancelled: false,
      };
    },
  };
  const workspace: ExecutionWorkspacePort = {
    async create() {
      return {
        root: "/fake-pilotdeck-code-runtime-root",
        async writeText(filePath) {
          return `/fake-pilotdeck-code-runtime-root/${filePath}`;
        },
        async cleanup() {},
      };
    },
  };

  const result = await createExecuteCodeTool({ codeRuntime, executionWorkspace: workspace }).execute(
    { code: "print('not evaluated by the fake runtime')" },
    context(),
  );

  assert.equal(result.data?.status, "success");
  assert.equal(result.data?.output, "from fake runtime");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.args, ["/fake-pilotdeck-code-runtime-root/script.py"]);
  assert.equal(requests[0]?.cwd, process.cwd());
  assert.equal(requests[0]?.env.PYTHONPATH?.split(":")[0], "/fake-pilotdeck-code-runtime-root");
});

test("execute_code delegates private RPC transport cleanup to its execution-world provider", async () => {
  const cleaned: ExecutionRpcTransport[] = [];
  const executionTransport: ExecutionTransportPort = {
    create() {
      return { kind: "tcp", host: "127.0.0.1", port: 0, token: "test-token" };
    },
    async cleanup(transport) {
      cleaned.push(transport);
    },
  };
  const codeRuntime: CodeRuntimePort = {
    async resolveExecutable() { return "python3"; },
    async run() {
      return {
        exitCode: 0,
        exitSignal: null,
        stdout: "transport-provider",
        stderr: "",
        timedOut: false,
        cancelled: false,
      };
    },
  };
  const workspace: ExecutionWorkspacePort = {
    async create() {
      return {
        root: "/fake-transport-execution-root",
        async writeText(filePath) { return `/fake-transport-execution-root/${filePath}`; },
        async cleanup() {},
      };
    },
  };

  const result = await createExecuteCodeTool({
    codeRuntime,
    executionWorkspace: workspace,
    executionTransport,
  }).execute({ code: "print('transport-provider')" }, context());

  assert.equal(result.data?.status, "success");
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0]?.kind, "tcp");
  assert.notEqual(cleaned[0]?.kind === "tcp" ? cleaned[0].port : 0, 0);
});

test("execute_code supplies per-run roots to an injected sandbox before code runtime dispatch", async () => {
  const policies: Array<{ workspaceRoot: string; executionRoot: string }> = [];
  const sandbox: SandboxPort = {
    async prepare(request) {
      return request;
    },
  };
  const codeRuntime: CodeRuntimePort = {
    async resolveExecutable() {
      return "python3";
    },
    async run() {
      return {
        exitCode: 0,
        exitSignal: null,
        stdout: "sandboxed",
        stderr: "",
        timedOut: false,
        cancelled: false,
      };
    },
  };
  const workspace: ExecutionWorkspacePort = {
    async create() {
      return {
        root: "/fake-sandbox-execution-root",
        async writeText(filePath) {
          return `/fake-sandbox-execution-root/${filePath}`;
        },
        async cleanup() {},
      };
    },
  };

  const result = await createExecuteCodeTool({
    codeRuntime,
    executionWorkspace: workspace,
    sandbox: {
      port: sandbox,
      resolvePolicy: (input) => {
        policies.push(input);
        return { mode: "danger-full-access", ...input };
      },
    },
  }).execute({ code: "print('sandboxed')" }, context());

  assert.equal(result.data?.status, "success");
  assert.deepEqual(policies, [{
    workspaceRoot: process.cwd(),
    executionRoot: "/fake-sandbox-execution-root",
  }]);
});

test("confined execute_code rejects nested host-side mutation helpers", async () => {
  const nestedCalls: string[] = [];
  const result = await createExecuteCodeTool({
    sandbox: {
      port: { async prepare(request) { return request; } },
      resolvePolicy: ({ workspaceRoot, executionRoot }) => ({
        mode: "read-only" as const,
        workspaceRoot,
        executionRoot,
      }),
    },
  }).execute({
    code: [
      "from pilotdeck_tools import bash, edit_file, write_file",
      "for helper, args in [(write_file, ('blocked.txt', 'x')), (edit_file, ('blocked.txt', 'x', 'y')), (bash, ('touch blocked.txt',))]:",
      "    try:",
      "        helper(*args)",
      "    except RuntimeError as error:",
      "        print(error)",
    ].join("\n"),
  }, {
    ...context(),
    executeTool: async (call) => {
      nestedCalls.push(call.name);
      throw new Error("confined execute_code must not dispatch host-side mutations");
    },
  });

  assert.equal(result.data?.status, "success");
  assert.equal(result.data?.tool_calls_made, 0);
  assert.match(result.data?.output ?? "", /Tool 'write_file' is not available/);
  assert.match(result.data?.output ?? "", /Tool 'edit_file' is not available/);
  assert.match(result.data?.output ?? "", /Tool 'bash' is not available/);
  assert.deepEqual(nestedCalls, []);
});

test("macOS execute_code applies its Seatbelt policy to direct Python writes", { skip: process.platform !== "darwin" }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-execute-code-sandbox-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const executionContext = {
    ...context(),
    cwd: workspace,
    permissionContext: {
      ...context().permissionContext,
      cwd: workspace,
    },
  };
  const sandbox = createNodeSandboxPort();
  const readOnly = await createExecuteCodeTool({
    sandbox: {
      port: sandbox,
      resolvePolicy: ({ workspaceRoot, executionRoot }) => ({
        mode: "read-only" as const,
        workspaceRoot,
        executionRoot,
      }),
    },
  }).execute({ code: "from pathlib import Path\nPath('read-only.txt').write_text('denied')" }, executionContext);

  assert.equal(readOnly.data?.status, "error");
  await assert.rejects(access(join(workspace, "read-only.txt")));

  const workspaceWrite = await createExecuteCodeTool({
    sandbox: {
      port: sandbox,
      resolvePolicy: ({ workspaceRoot, executionRoot }) => ({
        mode: "workspace-write" as const,
        workspaceRoot,
        executionRoot,
      }),
    },
  }).execute({ code: "from pathlib import Path\nPath('workspace-write.txt').write_text('allowed')" }, executionContext);

  assert.equal(workspaceWrite.data?.status, "success", workspaceWrite.data?.error);
  assert.equal(await readFile(join(workspace, "workspace-write.txt"), "utf8"), "allowed");
});
