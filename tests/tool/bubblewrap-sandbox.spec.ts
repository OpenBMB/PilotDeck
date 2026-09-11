import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BubblewrapSandboxCommandRunner,
  toShellCommand,
  type PilotDeckCommandOptions,
  type PilotDeckCommandRunner,
} from "../../src/tool/index.js";

const commandOptions: PilotDeckCommandOptions = {
  cwd: "/tmp/pilotdeck-sandbox/work/nested",
  timeoutMs: 30_000,
};

test("BubblewrapSandboxCommandRunner creates an isolated invocation without forwarding host environment", async () => {
  const calls: Array<{ command: string; options: PilotDeckCommandOptions }> = [];
  const delegate: PilotDeckCommandRunner = {
    async run(command, options) {
      calls.push({ command, options });
      return { exitCode: 0, stdout: "sandboxed\n", stderr: "", timedOut: false, durationMs: 1 };
    },
  };
  const runner = new BubblewrapSandboxCommandRunner({
    workspaceRoot: "/tmp/pilotdeck-sandbox/work",
    readOnlyWorkspace: true,
    executable: "/opt/bwrap/bin/bwrap",
    environment: { LANG: "C.UTF-8" },
    delegate,
  });

  const invocation = runner.buildInvocation("printf 'safe; not an outer shell command'", commandOptions.cwd);
  assert.equal(invocation.executable, "/opt/bwrap/bin/bwrap");
  assert.deepEqual(invocation.args.slice(0, 10), [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--unshare-net",
    "--clearenv",
    "--tmpfs",
  ]);
  assert.ok(invocation.args.includes("--ro-bind"));
  assert.ok(invocation.args.some((value, index) => value === "--ro-bind" && invocation.args[index + 1] === "/tmp/pilotdeck-sandbox/work"));
  assert.deepEqual(invocation.args.slice(-4), [
    "--",
    "/bin/sh",
    "-lc",
    "printf 'safe; not an outer shell command'",
  ]);
  assert.match(toShellCommand(invocation), /'printf '\\''safe; not an outer shell command'\\'''$/);
  assert.doesNotMatch(toShellCommand(invocation), /process\.env|HOME=/);

  const result = await runner.run("printf 'safe; not an outer shell command'", commandOptions);
  assert.equal(result.stdout, "sandboxed\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options, commandOptions);
  assert.equal(calls[0]?.command, toShellCommand(invocation));
});

test("BubblewrapSandboxCommandRunner rejects a cwd outside its workspace before invoking a process", () => {
  const runner = new BubblewrapSandboxCommandRunner({
    workspaceRoot: "/tmp/pilotdeck-sandbox/work",
    delegate: { async run() { throw new Error("must not run"); } },
  });
  assert.throws(
    () => runner.buildInvocation("pwd", "/tmp/another-workspace"),
    /cwd must be inside workspaceRoot/,
  );
});

test("BubblewrapSandboxCommandRunner can run a scratch shell without mounting its workspace", () => {
  const runner = new BubblewrapSandboxCommandRunner({
    workspaceRoot: "/tmp/pilotdeck-sandbox/work",
    mountWorkspace: false,
    executable: "/opt/bwrap/bin/bwrap",
    delegate: { async run() { throw new Error("must not run"); } },
  });

  const invocation = runner.buildInvocation("pwd", commandOptions.cwd);
  assert.equal(invocation.args.includes("/tmp/pilotdeck-sandbox/work"), false);
  const chdir = invocation.args.lastIndexOf("--chdir");
  assert.equal(invocation.args[chdir + 1], "/tmp");
  assert.ok(invocation.args.includes("--tmpfs"));
});

test("BubblewrapSandboxCommandRunner mounts only execute_code's private RPC directory", () => {
  const executeRoot = join(tmpdir(), "pilotdeck_execute_code_sandbox-test");
  const runner = new BubblewrapSandboxCommandRunner({
    workspaceRoot: "/tmp/pilotdeck-sandbox/work",
    executable: "/opt/bwrap/bin/bwrap",
    delegate: { async run() { throw new Error("must not run"); } },
  });

  const invocation = runner.buildInvocation("python3 script.py", commandOptions.cwd, {
    PILOTDECK_EXECUTE_CODE_TEMP_ROOT: executeRoot,
    PILOTDECK_RPC_SOCKET: join(executeRoot, "rpc.sock"),
    PYTHONPATH: executeRoot,
    HOST_SECRET: "must-not-cross-the-boundary",
  });
  assert.ok(invocation.args.some((value, index) => value === "--bind" && invocation.args[index + 1] === executeRoot));
  assert.ok(invocation.args.includes("PILOTDECK_RPC_SOCKET"));
  assert.ok(invocation.args.includes(join(executeRoot, "rpc.sock")));
  assert.ok(invocation.args.includes("PYTHONPATH"));
  assert.equal(invocation.args.includes("HOST_SECRET"), false);
  assert.equal(invocation.args.includes("must-not-cross-the-boundary"), false);
});
