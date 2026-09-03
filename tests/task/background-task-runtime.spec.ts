import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import { resolveDefaultCommandShell } from "../../src/runtime/commandShell.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly kills: Array<string | undefined> = [];
  unrefCalled = false;

  constructor(private readonly autoExitOnKill = false) {
    super();
  }

  unref(): void {
    this.unrefCalled = true;
  }

  kill(signal?: string): boolean {
    this.kills.push(signal);
    if (this.autoExitOnKill) {
      queueMicrotask(() => this.finish(null, signal ?? "SIGTERM"));
    }
    return true;
  }

  finish(code: number | null = 0, signal: string | null = null): void {
    this.emit("exit", code, signal);
  }
}

test("BackgroundTaskRuntime tracks output and emits one completion", async () => {
  const child = new FakeChild();
  let invocation: { command: string; args: string[]; options: Record<string, unknown> } | undefined;
  const env = { ...process.env, PILOTDECK_TEST_SHELL: "background" };
  const completions: unknown[] = [];
  const runtime = new BackgroundTaskRuntime({
    spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
      invocation = { command, args, options };
      return child;
    }) as never,
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    onCompletion: (event) => completions.push(event),
  });

  const task = await runtime.start({ command: "echo ok", cwd: "/tmp", env, sessionId: "s1", agentId: "a1" });
  assert.equal(task.status, "running");
  assert.equal(task.pid, 4242);
  assert.equal(child.unrefCalled, true);
  const expectedShell = resolveDefaultCommandShell({ env });
  assert.equal(invocation?.command, expectedShell.shell);
  assert.deepEqual(invocation?.args, expectedShell.args("echo ok"));
  assert.equal(invocation?.options.shell, undefined);
  assert.equal(invocation?.options.cwd, "/tmp");
  assert.equal(invocation?.options.env, env);
  assert.equal(invocation?.options.detached, true);
  assert.equal(invocation?.options.windowsVerbatimArguments, expectedShell.windowsVerbatimArguments);

  child.stdout.write("hello\n");
  child.stderr.write("warning\n");
  assert.equal(runtime.getOutput(task.taskId, 0).content, "hello\nwarning\n");

  child.finish(0);
  await runtime.waitFor(task.taskId);
  assert.equal(runtime.get(task.taskId)?.status, "completed");
  assert.equal(completions.length, 1);
  assert.match(String((completions[0] as { outputPreview: string }).outputPreview), /warning/);
});

test("BackgroundTaskRuntime marks non-zero exit as failed and filters list", async () => {
  const child = new FakeChild();
  const runtime = new BackgroundTaskRuntime({ spawn: (() => child) as never });
  const task = await runtime.start({ command: "false", cwd: "/tmp", agentId: "agent-a", kind: "watch" as never });
  child.finish(2);
  await runtime.waitFor(task.taskId);

  assert.equal(runtime.list({ status: "failed" }).length, 1);
  assert.equal(runtime.list({ status: "running" }).length, 0);
  assert.equal(runtime.list({ agentId: "other" }).length, 0);
});

test("BackgroundTaskRuntime handles spawn errors without throwing or losing completion", async () => {
  const completions: unknown[] = [];
  const runtime = new BackgroundTaskRuntime({
    spawn: (() => { throw new Error("spawn unavailable"); }) as never,
    onCompletion: (event) => completions.push(event),
  });

  const task = await runtime.start({ command: "missing", cwd: "/tmp" });
  assert.equal(task.status, "failed");
  assert.equal(runtime.getOutput(task.taskId, 0).content, "spawn error: spawn unavailable\n");
  assert.equal(completions.length, 1);
});

test("BackgroundTaskRuntime supports abort waits and idempotent stop", async () => {
  const child = new FakeChild();
  const runtime = new BackgroundTaskRuntime({ spawn: (() => child) as never });
  const task = await runtime.start({ command: "sleep", cwd: "/tmp" });
  const controller = new AbortController();
  controller.abort();
  const waited = await runtime.wait(task.taskId, { abortSignal: controller.signal });
  assert.equal(waited?.outcome, "aborted");

  child.finish(null, "SIGTERM");
  await runtime.stop(task.taskId);
  await runtime.stop(task.taskId);
  assert.equal(runtime.get(task.taskId)?.status, "cancelled");
  assert.deepEqual(child.kills, []);
});

test("BackgroundTaskRuntime enforces the task limit and stops by agent", async () => {
  const children = [new FakeChild(), new FakeChild()];
  let index = 0;
  const runtime = new BackgroundTaskRuntime({ maxTasks: 1, spawn: (() => children[index++]) as never });
  const first = await runtime.start({ command: "one", cwd: "/tmp", agentId: "a1" });
  await assert.rejects(() => runtime.start({ command: "two", cwd: "/tmp" }), /max tasks/);

  const stopPromise = runtime.killForAgent("a1");
  assert.deepEqual(children[0].kills, ["SIGTERM"]);
  children[0].finish(null, "SIGTERM");
  await stopPromise;
  assert.equal(first.status, "cancelled");
});

test("BackgroundTaskRuntime covers timeout, abort, unknown task and kill-all cleanup", async () => {
  const first = new FakeChild(true);
  const second = new FakeChild(true);
  let index = 0;
  const runtime = new BackgroundTaskRuntime({
    spawn: (() => [first, second][index++]) as never,
    onCompletion: () => { throw new Error("notification sink failed"); },
    completionPreviewBytes: 0,
  });
  const task = await runtime.start({ command: "one", cwd: "/tmp", agentId: "a" });
  assert.equal(await runtime.wait("missing"), undefined);
  await assert.rejects(() => runtime.waitFor("missing"), /Unknown taskId/);
  assert.throws(() => runtime.getOutput("missing", 0), /Unknown taskId/);
  const timeout = await runtime.wait(task.taskId, { timeoutMs: 1 });
  assert.equal(timeout?.outcome, "timeout");
  await runtime.stop(task.taskId);

  const next = await runtime.start({ command: "two", cwd: "/tmp", agentId: "b" });
  const controller = new AbortController();
  const pending = runtime.wait(next.taskId, { abortSignal: controller.signal });
  controller.abort();
  const aborted = await pending;
  assert.ok(aborted);
  assert.equal(aborted.outcome, "aborted");
  await runtime.killAll();
  assert.equal(runtime.get(next.taskId)?.status, "cancelled");
  await assert.rejects(() => runtime.stop("missing"), /Unknown taskId/);
});
