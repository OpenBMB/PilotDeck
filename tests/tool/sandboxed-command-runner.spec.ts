import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SandboxedCommandRunner,
  getSandboxBackend,
  isNativeSandboxAvailable,
} from "../../src/tool/builtin/bash/sandboxedCommandRunner.js";
import type { PilotDeckCommandRunner } from "../../src/tool/builtin/bash/commandRunner.js";

test("SandboxedCommandRunner executes commands and streams stdout/stderr", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-sandbox-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const runner = new SandboxedCommandRunner();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const result = await runner.run(
    `node -e "process.stdout.write('hello-out'); process.stderr.write('hello-err');"`,
    {
      cwd,
      timeoutMs: 10_000,
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /hello-out/);
  assert.match(result.stderr, /hello-err/);
  assert.match(stdoutChunks.join(""), /hello-out/);
  assert.match(stderrChunks.join(""), /hello-err/);
});

test("SandboxedCommandRunner terminates timed-out commands", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-sandbox-timeout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const runner = new SandboxedCommandRunner();
  const result = await runner.run(
    `node -e "setTimeout(() => {}, 30000)"`,
    {
      cwd,
      timeoutMs: 250,
    },
  );

  assert.equal(result.timedOut, true);
});

test("SandboxedCommandRunner falls back gracefully when backend is unsupported or via custom fallback", async () => {
  let calledFallback = false;
  const fallbackRunner: PilotDeckCommandRunner = {
    async run(command) {
      calledFallback = true;
      return {
        exitCode: 0,
        stdout: `fallback:${command}`,
        stderr: "",
        timedOut: false,
        durationMs: 1,
      };
    },
  };

  const runner = new SandboxedCommandRunner({ fallbackRunner });
  const backend = getSandboxBackend();
  assert.equal(typeof backend, "string");
  assert.equal(isNativeSandboxAvailable(), backend !== "unsupported");

  if (backend === "unsupported") {
    const res = await runner.run("echo ok", { cwd: process.cwd(), timeoutMs: 5000 });
    assert.equal(calledFallback, true);
    assert.equal(res.stdout, "fallback:echo ok");
  }
});

test("SandboxedCommandRunner state machine handles mock native binding streaming, abort, and errors", async () => {
  let killedId = 0;
  const runner = new SandboxedCommandRunner({
    binding: {
      sandboxBackend: () => "windows-job",
      startSandboxed(_opts, onEvent) {
        queueMicrotask(() => {
          onEvent(null, { kind: "stdout", data: Buffer.from("out-1") });
          onEvent(null, { kind: "stderr", data: Buffer.from("err-1") });
          onEvent(null, { kind: "exit", exitCode: 0 });
        });
        return 42;
      },
      killSandboxed(id) {
        killedId = id;
        return true;
      },
    },
  });

  const out: string[] = [];
  const res = await runner.run("echo test", {
    cwd: process.cwd(),
    timeoutMs: 5000,
    onStdout: (c) => out.push(c),
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, "out-1");
  assert.equal(res.stderr, "err-1");
  assert.deepEqual(out, ["out-1"]);

  const controller = new AbortController();
  const abortRunner = new SandboxedCommandRunner({
    binding: {
      sandboxBackend: () => "windows-job",
      startSandboxed(_opts, onEvent) {
        setTimeout(() => onEvent(null, { kind: "exit", exitCode: null }), 10);
        return 99;
      },
      killSandboxed(id) {
        killedId = id;
        return true;
      },
    },
  });
  const abortPromise = abortRunner.run("sleep", {
    cwd: process.cwd(),
    timeoutMs: 5000,
    signal: controller.signal,
  });
  controller.abort();
  await abortPromise;
  assert.equal(killedId, 99);
});

