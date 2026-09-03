import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EventEmitter } from "node:events";
import { BackgroundTaskRuntime } from "../../../src/task/runtime/BackgroundTaskRuntime.js";

test("BackgroundTaskRuntime does not detach Windows background tasks", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const calls: Array<{ command: string; args: string[]; options: { detached?: boolean; windowsHide?: boolean } }> = [];
    const runtime = new BackgroundTaskRuntime({
      spawn: ((command: string, args: string[], options: { detached?: boolean; windowsHide?: boolean }) => {
        calls.push({ command, args, options });
        return createFakeChild();
      }) as never,
    });

    const task = await runtime.start({
      command: "echo ready",
      cwd: "C:\\repo",
      env: { ComSpec: "cmd.exe" },
    });

    assert.equal(task.status, "running");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options.detached, false);
    assert.equal(calls[0]?.options.windowsHide, true);
    assert.equal(calls[0]?.command, "cmd.exe");
    assert.deepEqual(calls[0]?.args.slice(0, 3), ["/d", "/s", "/c"]);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("BackgroundTaskRuntime uses configured Windows Git Bash", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-git-bash-"));
  try {
    const bashPath = join(root, "bash.exe");
    writeFileSync(bashPath, "");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runtime = new BackgroundTaskRuntime({
      spawn: ((command: string, args: string[]) => {
        calls.push({ command, args });
        return createFakeChild();
      }) as never,
    });

    await runtime.start({
      command: "pwd",
      cwd: "C:\\repo",
      env: { PILOTDECK_GIT_BASH_PATH: bashPath },
    });

    assert.equal(calls[0]?.command, bashPath);
    assert.deepEqual(calls[0]?.args, ["-c", "pwd"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("BackgroundTaskRuntime keeps non-Windows background tasks detached", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const calls: Array<{ options: { detached?: boolean; windowsHide?: boolean } }> = [];
    const runtime = new BackgroundTaskRuntime({
      spawn: ((command: string, _args: string[], options: { detached?: boolean; windowsHide?: boolean }) => {
        void command;
        calls.push({ options });
        return createFakeChild();
      }) as never,
    });

    await runtime.start({ command: "sleep 30", cwd: "/tmp" });

    assert.equal(calls[0]?.options.detached, true);
    assert.equal(calls[0]?.options.windowsHide, false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    unref: () => void;
    kill: () => boolean;
  };
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => undefined;
  child.kill = () => true;
  return child;
}
