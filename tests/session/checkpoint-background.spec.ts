import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import { WorkspaceCheckpoints } from "../../src/session/checkpoints/WorkspaceCheckpoints.js";
import { createTaskCreateTool, createTaskWaitTool } from "../../src/tool/builtin/taskTools.js";
import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import { fixture, assertUnattributed, nodeCommand } from "./checkpoint-execution-fixture.js";

for (const order of ["task-tool", "tool-task", "failed-task"]) {
  test(`background ${order} captures completion before task_wait returns`, async t => {
    const f = await fixture(t), runtime = new BackgroundTaskRuntime();
    if (order !== "task-tool") await f.toolWrite("B");
    const task = await createTaskCreateTool(runtime).execute({ lifecycle: "finite", command: nodeCommand("require('node:fs').writeFileSync('a.txt','C');" + (order === "failed-task" ? "process.exitCode=1;" : "")) }, f.context);
    const result = await createTaskWaitTool(runtime).execute({ taskId: task.data!.taskId, timeoutMs: 10_000 }, f.context);
    assert.equal(result.data!.status, order === "failed-task" ? "failed" : "completed");
    if (order === "task-tool") await f.toolWrite("D");
    await assertUnattributed(f, order === "task-tool" ? "D" : "C");
  });
}

class ControlledChild extends EventEmitter {
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough(); readonly pid = 42;
  unref() {}
  finish() { this.emit("exit", 0, null); }
}

test("cross-turn background completion cannot rewrite old checkpoints or a new turn's journal", async t => {
  const f = await fixture(t); await f.toolWrite("B");
  const child = new ControlledChild(), runtime = new BackgroundTaskRuntime({ spawn: (() => child) as never });
  const task = await createTaskCreateTool(runtime).execute({ lifecycle: "finite", command: "controlled writer" }, f.context);
  const first = (await f.history.finishTurn("complete"))!;
  assert.equal(first.changes[0].restorable, false); assert.equal(f.store.busy, true);
  const newHistory = new WorkspaceCheckpoints(f.workspace, f.home);
  await newHistory.beginTurn("session", "next", []);
  await writeFile(f.file, "C"); child.finish();
  await createTaskWaitTool(runtime).execute({ taskId: task.data!.taskId, timeoutMs: 1000 }, f.context);
  const second = (await newHistory.finishTurn("complete"))!;
  assert.equal(f.store.busy, false);
  assert.equal((await f.store.diff("session", first.id, "a.txt")).newContent, "B");
  assert.equal((await f.store.preview("session", first.id)).files[0].status, "unprotected");
  assert.deepEqual(second.changes, []);
  const late = (await f.store.list("session")).find(record => record.phase === "after" && record.turnId === "turn")!;
  assert.equal((await f.store.diff("session", late.id, "a.txt")).newContent, "C");
  assert.equal(f.store.summary(late).changes[0].restorable, false);
  await f.history.beginTurn("session", "last", []); await f.toolWrite("D");
  const third = (await f.history.finishTurn("complete"))!;
  assert.equal((await f.store.preview("session", third.id)).files[0].status, "ready");
});

test("turn completion flushes a task finalization already capturing its postimage", async t => {
  const f = await fixture(t); await f.toolWrite("B");
  const child = new ControlledChild(), runtime = new BackgroundTaskRuntime({ spawn: (() => child) as never });
  await createTaskCreateTool(runtime).execute({ lifecycle: "finite", command: "controlled writer" }, f.context);
  await writeFile(f.file, "C"); child.finish();
  await assertUnattributed(f, "C");
});
