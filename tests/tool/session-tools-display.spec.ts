import test from "node:test";
import assert from "node:assert/strict";

import { createTodoWriteTool } from "../../src/tool/builtin/todoWrite.js";
import { createTaskListTool } from "../../src/tool/builtin/taskTools.js";
import type { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import type { PilotDeckBackgroundBashTask } from "../../src/task/protocol/types.js";

function baseContext() {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: "/tmp",
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd: "/tmp",
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
  };
}

function textOf(result: { content: Array<{ type: string; text?: string; value?: unknown }> }): string {
  const first = result.content[0];
  if (first?.type === "text") return first.text ?? "";
  if (first?.type === "json") return JSON.stringify(first.value);
  return "";
}

test("todo_write returns the actual todo list in model-visible content", async () => {
  const result = await createTodoWriteTool().execute({
    todos: [
      { id: "review", content: "Review tool outputs", status: "in_progress", priority: "high" },
      { id: "tests", content: "Add focused tests", status: "pending" },
    ],
    reason: "Track review steps",
  }, baseContext());

  const text = textOf(result);
  assert.match(text, /Todo list updated:/);
  assert.match(text, /reason: Track review steps/);
  assert.match(text, /- \[in_progress\] id=review priority=high Review tool outputs/);
  assert.match(text, /- \[pending\] id=tests Add focused tests/);
});

test("task_list returns model-visible status and next action hints", async () => {
  const startedAt = new Date("2026-07-09T00:00:00.000Z");
  const task: PilotDeckBackgroundBashTask = {
    taskId: "task-1",
    type: "local_bash",
    kind: "bash",
    command: "npm test -- --watch=false",
    cwd: "/tmp",
    status: "running",
    pid: 123,
    completionStatusSentInAttachment: false,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    interrupted: false,
    startedAt,
    outputBytes: 4096,
  };
  const runtime = {
    list: () => [task],
  } as unknown as BackgroundTaskRuntime;

  const result = await createTaskListTool(runtime).execute({}, baseContext());
  const text = textOf(result);

  assert.match(text, /task_list count=1/);
  assert.match(text, /taskId=task-1 status=running/);
  assert.match(text, /outputBytes=4096/);
  assert.match(text, /use task_output\({ taskId: "task-1", offset: 0 }\)/);
});
