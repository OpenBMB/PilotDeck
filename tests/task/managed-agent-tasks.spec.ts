import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";

import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import type { PilotDeckBackgroundAgentTask } from "../../src/task/protocol/types.js";

function createFakeBashChild(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  unref(): void;
  kill(signal?: string): boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    unref(): void;
    kill(signal?: string): boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.unref = () => {};
  child.kill = () => true;
  return child;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("startManaged completes with taskId === subagentId, report in the output store, and one completion event", async () => {
  const completions: unknown[] = [];
  const runtime = new BackgroundTaskRuntime({ onCompletion: (event) => completions.push(event) });
  const task = await runtime.startManaged({
    subagentId: "sub-1",
    label: "probe child",
    sessionId: "s1",
    originTurnId: "t1",
    subagentType: "explore",
    run: async () => "final report body",
  });

  assert.equal(task.taskId, "sub-1");
  assert.equal(task.type, "local_agent");
  assert.equal(task.kind, "agent");
  assert.equal(task.subagentId, "sub-1");
  assert.equal(runtime.get("sub-1")?.status, "completed");
  assert.match(runtime.getOutput("sub-1", 0).content, /final report body/);
  assert.equal(completions.length, 1);
  const event = completions[0] as { taskId: string; kind?: string; subagentId?: string; status: string };
  assert.equal(event.taskId, "sub-1");
  assert.equal(event.kind, "agent");
  assert.equal(event.subagentId, "sub-1");
  assert.equal(event.status, "completed");
});

test("startManaged marks a rejected run as failed with the error in the output store", async () => {
  const runtime = new BackgroundTaskRuntime();
  await runtime.startManaged({
    subagentId: "sub-fail",
    label: "doomed",
    run: async () => {
      throw new Error("gate exploded");
    },
  });
  assert.equal(runtime.get("sub-fail")?.status, "failed");
  assert.match(runtime.getOutput("sub-fail", 0).content, /error: gate exploded/);
});

test("cooperative stop cancels the run and wins over a late report", async () => {
  const completions: unknown[] = [];
  const runtime = new BackgroundTaskRuntime({ onCompletion: (event) => completions.push(event) });
  await runtime.startManaged({
    subagentId: "sub-slow",
    label: "slow",
    run: async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await delay(25);
      return "late report";
    },
  });
  await runtime.stop("sub-slow", { graceMs: 1_000 });
  assert.equal(runtime.get("sub-slow")?.status, "cancelled");
  assert.equal(completions.length, 1);
  const stopped = await runtime.stop("sub-slow", { graceMs: 1 });
  assert.equal(stopped, undefined); // idempotent no-op
  assert.equal(completions.length, 1);
});

test("stop force-cancels a non-cooperative run after the grace window", async () => {
  const runtime = new BackgroundTaskRuntime();
  await runtime.startManaged({
    subagentId: "sub-stuck",
    label: "stuck",
    run: () => new Promise<string>(() => {}), // ignores the abort signal forever
  });
  await runtime.stop("sub-stuck", { graceMs: 20 });
  assert.equal(runtime.get("sub-stuck")?.status, "cancelled");
  assert.equal(runtime.list({ status: "running" }).length, 0);
});

test("running agent capacity is bounded and freed when tasks complete", async () => {
  const runtime = new BackgroundTaskRuntime({ maxRunningAgentTasks: 1 });
  const release = createDeferred();
  const first = await runtime.startManaged({
    subagentId: "sub-a",
    label: "a",
    run: () => release.promise.then(() => "done-a"),
  });
  await assert.rejects(
    () => runtime.startManaged({ subagentId: "sub-b", label: "b", run: async () => "done-b" }),
    /capacity/,
  );
  assert.equal(first.status, "running");
  release.open();
  await runtime.waitFor("sub-a");
  const second = await runtime.startManaged({
    subagentId: "sub-b",
    label: "b",
    run: async () => "done-b",
  });
  assert.equal(second.status, "completed");
});

test("retained terminal agent records are pruned oldest-first", async () => {
  const runtime = new BackgroundTaskRuntime({ maxRetainedAgentTasks: 2 });
  await runtime.startManaged({ subagentId: "keep-oldest", label: "1", run: async () => "one" });
  await runtime.startManaged({ subagentId: "keep-newest", label: "2", run: async () => "two" });
  await runtime.waitFor("keep-oldest");
  await runtime.waitFor("keep-newest");
  await runtime.startManaged({ subagentId: "pushes-out", label: "3", run: async () => "three" });
  await runtime.waitFor("pushes-out");

  assert.equal(runtime.get("keep-oldest"), undefined);
  assert.notEqual(runtime.get("keep-newest"), undefined);
  assert.notEqual(runtime.get("pushes-out"), undefined);
});

test("agent tasks are independent of the inherited bash maxTasks lifetime cap", async () => {
  const runtime = new BackgroundTaskRuntime({ maxTasks: 1, spawn: (() => createFakeBashChild()) as never });
  const bashTask = await runtime.start({ command: "sleep", cwd: "/tmp" });
  assert.equal(bashTask.status, "running");

  const agent = (await runtime.startManaged({
    subagentId: "sub-despite-bash",
    label: "agent",
    run: async () => "still works",
  })) as PilotDeckBackgroundAgentTask;
  await runtime.waitFor(agent.taskId);
  assert.equal(agent.status, "completed");
});

test("duplicate subagent ids are rejected", async () => {
  const release = createDeferred();
  const runtime = new BackgroundTaskRuntime();
  await runtime.startManaged({
    subagentId: "sub-dup",
    label: "first",
    run: () => release.promise.then(() => "first"),
  });
  await assert.rejects(
    () => runtime.startManaged({ subagentId: "sub-dup", label: "second", run: async () => "second" }),
    /duplicate task id/i,
  );
  release.open();
  await runtime.waitFor("sub-dup");
});

function createDeferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}
