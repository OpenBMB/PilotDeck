import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionRuntime, createDefaultPermissionContext } from "../../src/permission/index.js";
import {
  handleExecuteCodeRpcLineForTests,
  setExecuteCodeTransportOverrideForTests,
} from "../../src/tool/builtin/executeCode.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import type { PilotDeckToolCall, PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

function createContext(cwd: string, overrides: Partial<PilotDeckToolRuntimeContext> = {}): PilotDeckToolRuntimeContext {
  return {
    sessionId: "test-session",
    turnId: "test-turn",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false }),
    ...overrides,
  };
}

async function execute(call: PilotDeckToolCall, context: PilotDeckToolRuntimeContext) {
  const runtime = new ToolRuntime(createBuiltinRegistry({ webSearch: false, webFetch: false, agent: false, askUserQuestion: false }), new PermissionRuntime());
  return runtime.execute(call, context);
}

function data(result: Awaited<ReturnType<typeof execute>>) {
  assert.equal(result.type, "success");
  return result.data as { status: string; output: string; error?: string; tool_calls_made: number; tool_call_log: Array<{ tool: string; ok: boolean }> };
}

async function withTransportOverride<T>(kind: "uds" | "tcp", run: () => Promise<T>): Promise<T> {
  setExecuteCodeTransportOverrideForTests(kind);
  try {
    return await run();
  } finally {
    setExecuteCodeTransportOverrideForTests(undefined);
  }
}

test("execute_code returns stdout from Python", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-hello-"));
  try {
    const result = await execute({ id: "call-1", name: "execute_code", input: { code: 'print("hello")' } }, createContext(cwd));
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /hello/);
    assert.equal(output.tool_calls_made, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code runs from workspace cwd and preserves helper imports", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-cwd-"));
  try {
    const code = `import os
import pilotdeck_tools
print(os.getcwd())
print(os.environ.get("PILOTDECK_WORKSPACE_CWD"))
print(os.environ.get("PILOTDECK_EXECUTE_CODE_TEMP_ROOT") in os.environ.get("PYTHONPATH", "").split(os.pathsep))
print(hasattr(pilotdeck_tools, "read_file"))`;
    const result = await execute({ id: "call-cwd", name: "execute_code", input: { code } }, createContext(cwd));
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, new RegExp(`${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+True\\s+True`, "s"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code fully inherits runtime env including API and proxy variables", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-env-"));
  try {
    const inheritedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENROUTER_API_KEY: "test-openrouter-secret",
      DASHSCOPE_API_KEY: "test-dashscope-secret",
      TAVILY_API_KEY: "test-tavily-secret",
      HTTP_PROXY: "http://127.0.0.1:17890",
      HTTPS_PROXY: "http://127.0.0.1:17890",
      NO_PROXY: "localhost,127.0.0.1",
      PYTHONPATH: "/existing/pythonpath",
    };
    const code = `import os
names = ["OPENROUTER_API_KEY", "DASHSCOPE_API_KEY", "TAVILY_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
print(" ".join("present" if os.environ.get(name) else "missing" for name in names))
parts = os.environ.get("PYTHONPATH", "").split(os.pathsep)
print(parts[0] == os.environ.get("PILOTDECK_EXECUTE_CODE_TEMP_ROOT"))
print("/existing/pythonpath" in parts)
print(os.environ.get("OPENROUTER_API_KEY") == "test-openrouter-secret")`;
    const result = await execute(
      { id: "call-env", name: "execute_code", input: { code } },
      createContext(cwd, { env: inheritedEnv }),
    );
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /present present present present present present\s+True\s+True\s+True/s);
    assert.doesNotMatch(output.output, /test-(openrouter|dashscope|tavily)-secret/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code accepts optional description and ignores it", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-description-"));
  try {
    const result = await execute(
      {
        id: "call-description",
        name: "execute_code",
        input: {
          code: 'print("description ignored")',
          description: "This field should not affect execution or leak into metadata.",
        },
      },
      createContext(cwd),
    );
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /description ignored/);
    assert.doesNotMatch(JSON.stringify(result.metadata), /This field should not affect execution/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code rejects invalid Python syntax before execution", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-syntax-"));
  try {
    const result = await execute({ id: "call-syntax", name: "execute_code", input: { code: "def broken(:\n    pass" } }, createContext(cwd));
    assert.equal(result.type, "error");
    assert.equal(result.error.code, "invalid_tool_input");
    assert.match(result.error.details?.issues ? JSON.stringify(result.error.details.issues) : "", /Python syntax error/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code can call read_file through PilotDeck RPC", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-read-"));
  try {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n", "utf8");
    const code = `from pilotdeck_tools import read_file\nresult = read_file("note.txt", offset=1, limit=1)\nprint(result["content"] if isinstance(result, dict) and "content" in result else result)`;
    const result = await execute({ id: "call-2", name: "execute_code", input: { code } }, createContext(cwd));
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /alpha/);
    assert.equal(output.tool_calls_made, 1);
    assert.equal(output.tool_call_log[0]?.tool, "read_file");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code exposes write helpers but keeps unsafe helpers unavailable", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-blocked-"));
  try {
    const code = `import pilotdeck_tools
print(hasattr(pilotdeck_tools, "write_file"))
print(hasattr(pilotdeck_tools, "edit_file"))
print(hasattr(pilotdeck_tools, "agent"))
print(hasattr(pilotdeck_tools, "execute_code"))
print(hasattr(pilotdeck_tools, "task_create"))`;
    const result = await execute({ id: "call-3", name: "execute_code", input: { code } }, createContext(cwd));
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /True\s+True\s+False\s+False\s+False/s);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code can create a file with write_file", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-write-new-"));
  try {
    const code = `from pilotdeck_tools import write_file
write_file("new.txt", "hello from python\\n")
print("created")`;
    const result = await execute({ id: "call-write-new", name: "execute_code", input: { code } }, createContext(cwd));
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /created/);
    assert.equal(output.tool_calls_made, 1);
    assert.equal(output.tool_call_log[0]?.tool, "write_file");
    assert.equal(await readFile(path.join(cwd, "new.txt"), "utf8"), "hello from python\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code requires read_file before overwriting an existing file", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-write-existing-"));
  try {
    await writeFile(path.join(cwd, "note.txt"), "old\n", "utf8");
    const rejectedCode = `from pilotdeck_tools import write_file
try:
    write_file("note.txt", "new\\n")
except Exception as exc:
    print(str(exc))`;
    const rejected = await execute({ id: "call-write-existing-reject", name: "execute_code", input: { code: rejectedCode } }, createContext(cwd));
    const rejectedOutput = data(rejected);
    assert.equal(rejectedOutput.status, "success");
    assert.match(rejectedOutput.output, /File has not been read yet/);
    assert.equal(await readFile(path.join(cwd, "note.txt"), "utf8"), "old\n");

    const acceptedCode = `from pilotdeck_tools import read_file, write_file
read_file("note.txt")
write_file("note.txt", "new\\n")
print("updated")`;
    const accepted = await execute({ id: "call-write-existing-accept", name: "execute_code", input: { code: acceptedCode } }, createContext(cwd));
    const acceptedOutput = data(accepted);
    assert.equal(acceptedOutput.status, "success");
    assert.match(acceptedOutput.output, /updated/);
    assert.equal(acceptedOutput.tool_calls_made, 2);
    assert.deepEqual(acceptedOutput.tool_call_log.map((entry) => entry.tool), ["read_file", "write_file"]);
    assert.equal(await readFile(path.join(cwd, "note.txt"), "utf8"), "new\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code can edit an existing file after read_file", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-edit-"));
  try {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n", "utf8");
    const code = `from pilotdeck_tools import read_file, edit_file
read_file("note.txt")
edit_file("note.txt", "beta", "gamma")
print("edited")`;
    const result = await execute({ id: "call-edit", name: "execute_code", input: { code } }, createContext(cwd));
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /edited/);
    assert.equal(output.tool_calls_made, 2);
    assert.deepEqual(output.tool_call_log.map((entry) => entry.tool), ["read_file", "edit_file"]);
    assert.equal(await readFile(path.join(cwd, "note.txt"), "utf8"), "alpha\ngamma\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code enforces max_tool_calls", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-limit-"));
  try {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n", "utf8");
    const code = `from pilotdeck_tools import read_file\nprint(read_file("note.txt")["content"])\ntry:\n    read_file("note.txt")\nexcept Exception as exc:\n    print(str(exc))`;
    const result = await execute({ id: "call-4", name: "execute_code", input: { code, max_tool_calls: 1 } }, createContext(cwd));
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /Tool call limit reached/);
    assert.equal(output.tool_calls_made, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code kills timed out scripts", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-timeout-"));
  try {
    const result = await execute(
      { id: "call-5", name: "execute_code", input: { code: "import time\ntime.sleep(5)", timeout_seconds: 1 } },
      createContext(cwd),
    );
    const output = data(result);
    assert.equal(output.status, "timeout");
    assert.match(output.error ?? "", /timed out/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code inherits secret-like environment variables without exposing them in metadata", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-secret-env-"));
  try {
    const result = await execute(
      { id: "call-6", name: "execute_code", input: { code: 'import os\nprint(os.environ.get("OPENAI_API_KEY") == "secret-value")' } },
      createContext(cwd, { env: { ...process.env, OPENAI_API_KEY: "secret-value" } }),
    );
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /True/);
    assert.doesNotMatch(output.output, /secret-value/);
    assert.equal(result.metadata?.env_inheritance, "full");
    assert.equal(result.metadata?.cwd, cwd);
    assert.equal(result.metadata?.python_path_augmented, true);
    assert.doesNotMatch(JSON.stringify(result.metadata), /secret-value/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code nested bash still goes through permission runtime", async () => {
  const registry = new ToolRegistry();
  registry.register(createBuiltinRegistry({ webSearch: false, webFetch: false, agent: false, askUserQuestion: false }).get("execute_code")!);
  registry.register({
    name: "bash",
    description: "test bash",
    kind: "shell",
    inputSchema: { type: "object", required: ["command"], additionalProperties: false, properties: { command: { type: "string" } } },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: async () => ({
      type: "deny",
      reason: { type: "runtime", message: "blocked in test" },
      message: "blocked in test",
    }),
    execute: async () => ({ content: [{ type: "text", text: "should not run" }] }),
  } satisfies PilotDeckToolDefinition);
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-perm-"));
  try {
    const result = await runtime.execute(
      {
        id: "call-7",
        name: "execute_code",
        input: { code: 'from pilotdeck_tools import bash\ntry:\n    bash("echo no")\nexcept Exception as exc:\n    print(str(exc))' },
      },
      createContext(cwd),
    );
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /blocked in test/);
    assert.equal(output.tool_calls_made, 1);
    assert.equal(output.tool_call_log[0]?.ok, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code nested write_file still goes through permission runtime", async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register(createBuiltinRegistry({ webSearch: false, webFetch: false, agent: false, askUserQuestion: false }).get("execute_code")!);
  registry.register({
    name: "write_file",
    description: "test write_file",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path", "content"],
      additionalProperties: false,
      properties: { file_path: { type: "string" }, content: { type: "string" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkPermissions: async () => ({
      type: "deny",
      reason: { type: "runtime", message: "write blocked in test" },
      message: "write blocked in test",
    }),
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "should not write" }] };
    },
  } satisfies PilotDeckToolDefinition);
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-write-perm-"));
  try {
    const result = await runtime.execute(
      {
        id: "call-write-perm",
        name: "execute_code",
        input: { code: 'from pilotdeck_tools import write_file\ntry:\n    write_file("no.txt", "no")\nexcept Exception as exc:\n    print(str(exc))' },
      },
      createContext(cwd),
    );
    const output = data(result);
    assert.equal(output.status, "success");
    assert.match(output.output, /write blocked in test/);
    assert.equal(output.tool_calls_made, 1);
    assert.equal(output.tool_call_log[0]?.tool, "write_file");
    assert.equal(output.tool_call_log[0]?.ok, false);
    assert.equal(executed, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execute_code TCP transport returns stdout", async () => {
  await withTransportOverride("tcp", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-tcp-stdout-"));
    try {
      const result = await execute({ id: "call-tcp-stdout", name: "execute_code", input: { code: 'print("tcp hello")' } }, createContext(cwd));
      const output = data(result);
      assert.equal(output.status, "success");
      assert.match(output.output, /tcp hello/);
      assert.equal(output.tool_calls_made, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("execute_code TCP transport can call read_file", async () => {
  await withTransportOverride("tcp", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-tcp-read-"));
    try {
      await writeFile(path.join(cwd, "note.txt"), "tcp alpha\n", "utf8");
      const code = `from pilotdeck_tools import read_file\nprint(read_file("note.txt")["content"])`;
      const result = await execute({ id: "call-tcp-read", name: "execute_code", input: { code } }, createContext(cwd));
      const output = data(result);
      assert.equal(output.status, "success");
      assert.match(output.output, /tcp alpha/);
      assert.equal(output.tool_calls_made, 1);
      assert.equal(output.tool_call_log[0]?.tool, "read_file");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("execute_code TCP transport injects loopback env", async () => {
  await withTransportOverride("tcp", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-tcp-env-"));
    try {
      const code = 'import os\nprint(os.environ.get("PILOTDECK_RPC_HOST"))\nprint(os.environ.get("PILOTDECK_RPC_PORT", "").isdigit())\nprint(len(os.environ.get("PILOTDECK_RPC_TOKEN", "")) > 20)\nprint(os.environ.get("PILOTDECK_RPC_SOCKET"))';
      const result = await execute({ id: "call-tcp-env", name: "execute_code", input: { code } }, createContext(cwd));
      const output = data(result);
      assert.equal(output.status, "success");
      assert.match(output.output, /127\.0\.0\.1\s+True\s+True\s+None/s);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("execute_code UDS transport injects socket env", async () => {
  await withTransportOverride("uds", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pilotdeck-execute-code-uds-env-"));
    try {
      const code = 'import os\nprint(bool(os.environ.get("PILOTDECK_RPC_SOCKET")))\nprint(os.environ.get("PILOTDECK_RPC_HOST"))\nprint(os.environ.get("PILOTDECK_RPC_TOKEN"))';
      const result = await execute({ id: "call-uds-env", name: "execute_code", input: { code } }, createContext(cwd));
      const output = data(result);
      assert.equal(output.status, "success");
      assert.match(output.output, /True\s+None\s+None/s);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("execute_code TCP RPC rejects invalid token before executing tools", async () => {
  let executed = false;
  const response = await handleExecuteCodeRpcLineForTests(
    JSON.stringify({ token: "wrong", tool: "read_file", args: { file_path: "note.txt" } }),
    {
      expectedToken: "correct",
      executeTool: async () => {
        executed = true;
        return {
          type: "success",
          toolCallId: "nested",
          toolName: "read_file",
          content: [{ type: "text", text: "should not run" }],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      },
    },
  );
  assert.equal(response.code, "invalid_rpc_token");
  assert.equal(executed, false);
});
