import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { NodeShellCommandRunner } from "../../src/tool/builtin/bash/commandRunner.js";
import { resolveDefaultCommandShell } from "../../src/runtime/commandShell.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
}

test("foreground bash runner invokes the resolved shell explicitly", async () => {
  const child = new FakeChild();
  let invocation: { command: string; args: string[]; options: Record<string, unknown> } | undefined;
  const env = { ...process.env, PILOTDECK_TEST_SHELL: "runner" };
  const runner = new NodeShellCommandRunner(((command: string, args: string[], options: Record<string, unknown>) => {
    invocation = { command, args, options };
    return child;
  }) as never);

  const resultPromise = runner.run("printf ok", { cwd: "/tmp", env, timeoutMs: 1000 });
  child.stdout.end("ok");
  child.stderr.end();
  child.emit("close", 0);
  const result = await resultPromise;
  const expected = resolveDefaultCommandShell({ env });

  assert.equal(invocation?.command, expected.shell);
  assert.deepEqual(invocation?.args, expected.args("printf ok"));
  assert.equal(invocation?.options.shell, undefined);
  assert.equal(invocation?.options.cwd, "/tmp");
  assert.equal(invocation?.options.env, env);
  assert.equal(invocation?.options.detached, process.platform !== "win32");
  assert.equal(invocation?.options.windowsVerbatimArguments, expected.windowsVerbatimArguments);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
});
