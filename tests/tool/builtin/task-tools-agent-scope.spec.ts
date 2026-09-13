import test from "node:test";
import assert from "node:assert/strict";

import { BackgroundTaskRuntime } from "../../../src/task/runtime/BackgroundTaskRuntime.js";
import {
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
  createTaskWaitTool,
} from "../../../src/tool/builtin/taskTools.js";
import type { PilotDeckToolRuntimeContext } from "../../../src/tool/index.js";

function contextFor(sessionId: string): PilotDeckToolRuntimeContext {
  return {
    sessionId,
    turnId: "t1",
    cwd: "/tmp",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: "/tmp",
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function createGatedRuntime(): { runtime: BackgroundTaskRuntime; release: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const runtime = new BackgroundTaskRuntime();
  void runtime.startManaged({
    subagentId: "owned-by-s1",
    label: "s1 agent",
    sessionId: "s1",
    originTurnId: "turn-1",
    subagentType: "explore",
    run: async (signal) => {
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      if (signal.aborted) throw new Error("stopped");
      return "s1 final report";
    },
  });
  return { runtime, release: () => open() };
}

test("task_output from another session cannot inspect a local_agent task", async () => {
  const { runtime } = createGatedRuntime();
  await assert.rejects(
    () => createTaskOutputTool(runtime).execute({ taskId: "owned-by-s1" }, contextFor("s2")),
    /Unknown taskId/,
  );
  await runtime.stop("owned-by-s1");
});

test("task_stop and task_wait from another session cannot touch a local_agent task", async () => {
  const { runtime, release } = createGatedRuntime();
  await assert.rejects(
    () => createTaskStopTool(runtime).execute({ taskId: "owned-by-s1" }, contextFor("s2")),
    /Unknown taskId/,
  );
  await assert.rejects(
    () => createTaskWaitTool(runtime).execute({ taskId: "owned-by-s1", timeoutMs: 10 }, contextFor("s2")),
    /Unknown taskId/,
  );
  assert.equal(runtime.get("owned-by-s1")?.status, "running");
  release();
  await runtime.waitFor("owned-by-s1");
});

test("task_list filters foreign local_agent tasks but keeps same-session ones", async () => {
  const { runtime, release } = createGatedRuntime();
  const s1View = createTaskListTool(runtime).execute({}, contextFor("s1"));
  const s2View = createTaskListTool(runtime).execute({}, contextFor("s2"));

  release();
  await runtime.waitFor("owned-by-s1");
  const seenByS1 = (await s1View).data?.tasks ?? [];
  const seenByS2 = (await s2View).data?.tasks ?? [];
  assert.equal(seenByS1.filter((task) => task.taskId === "owned-by-s1").length, 1);
  assert.equal(seenByS2.filter((task) => task.taskId === "owned-by-s1").length, 0);
});

test("owning session keeps full task_output / task_stop access", async () => {
  const { runtime, release } = createGatedRuntime();
  release();
  const waited = await createTaskWaitTool(runtime).execute(
    { taskId: "owned-by-s1", timeoutMs: 2_000 },
    contextFor("s1"),
  );
  assert.equal(waited.data?.status, "completed");
  assert.match(waited.data?.content ?? "", /s1 final report/);

  const stopped = await createTaskStopTool(runtime).execute({ taskId: "owned-by-s1" }, contextFor("s1"));
  assert.equal(stopped.data?.status, "completed"); // stop on a terminal task is a no-op
});

test("task_stop returns the settled status even if new work prunes its record", async () => {
  const runtime = new BackgroundTaskRuntime({
    maxRetainedAgentTasks: 1,
    onCompletion: event => {
      if (event.taskId === "pruned-on-stop") {
        void runtime.startManaged({ subagentId: "newer-task", label: "new work", sessionId: "s1", run: async () => "done" });
      }
    },
  });
  await runtime.startManaged({
    subagentId: "pruned-on-stop", label: "stop me", sessionId: "s1",
    run: signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const result = await createTaskStopTool(runtime).execute({ taskId: "pruned-on-stop" }, contextFor("s1"));
  assert.equal(runtime.get("pruned-on-stop"), undefined, "new work really pruned the old record");
  assert.equal(result.data?.status, "cancelled");
});
