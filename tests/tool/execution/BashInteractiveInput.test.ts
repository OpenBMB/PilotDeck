import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  InMemoryElicitationChannel,
  ToolRegistry,
  ToolRuntime,
  createBashTool,
} from "../../../src/tool/index.js";
import { PermissionRuntime, createDefaultPermissionContext } from "../../../src/permission/index.js";
import { NodeShellCommandRunner, detectInteractivePrompt } from "../../../src/tool/builtin/bash/commandRunner.js";

test("detectInteractivePrompt recognizes credential prompts", () => {
  assert.deepEqual(detectInteractivePrompt("Password: "), {
    prompt: "Password:",
    secret: true,
  });
  assert.deepEqual(detectInteractivePrompt("Username: "), {
    prompt: "Username:",
    secret: false,
  });
  assert.equal(detectInteractivePrompt("warning: nothing to do"), undefined);
});

test("NodeShellCommandRunner answers an interactive stdout prompt", async () => {
  const runner = new NodeShellCommandRunner();
  const result = await runner.run(
    `${process.execPath} -e "process.stdout.write('Username: '); process.stdin.once('data', d => { console.log('hello ' + String(d).trim()); process.exit(0); })"`,
    {
      cwd: process.cwd(),
      timeoutMs: 5000,
      onInputRequest: async (request) => {
        assert.equal(request.prompt, "Username:");
        assert.equal(request.secret, false);
        return { type: "answered", input: "ada" };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello ada/);
  assert.equal(result.interactions?.[0]?.answered, true);
});

test("bash tool requests secure input through elicitation and redacts metadata", async () => {
  const registry = new ToolRegistry();
  registry.register(createBashTool());
  const cwd = resolve(".");
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    {
      id: "call-1",
      name: "bash",
      input: {
        command: `${process.execPath} -e "process.stdout.write('Password: '); process.stdin.once('data', d => { console.log(String(d).trim() === 's3cr3t' ? 'accepted' : 'rejected'); process.exit(0); })"`,
      },
    },
    {
      sessionId: "s",
      turnId: "t",
      cwd,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions" }),
      elicitation: new InMemoryElicitationChannel({ stdin: "s3cr3t" }),
    },
  );

  assert.equal(result.type, "success");
  assert.match(result.content.map((item) => item.type === "text" ? item.text : "").join("\n"), /accepted/);
  assert.doesNotMatch(JSON.stringify(result.metadata ?? {}), /s3cr3t/);
  assert.equal((result.metadata?.interactions as Array<{ secret: boolean }> | undefined)?.[0]?.secret, true);
});

test("bash tool fails clearly when interactive input has no channel", async () => {
  const registry = new ToolRegistry();
  registry.register(createBashTool());
  const cwd = resolve(".");
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    {
      id: "call-1",
      name: "bash",
      input: {
        command: `${process.execPath} -e "process.stdout.write('Username: '); setTimeout(() => {}, 10000)"`,
        timeout: 5000,
      },
    },
    {
      sessionId: "s",
      turnId: "t",
      cwd,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions" }),
    },
  );

  assert.equal(result.type, "error");
  assert.match(result.error.message, /interactive input/i);
});
