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

