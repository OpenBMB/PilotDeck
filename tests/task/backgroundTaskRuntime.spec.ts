import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BackgroundTaskRuntime, type BackgroundTaskCompletionEvent } from "../../src/task/runtime/BackgroundTaskRuntime.js";

describe("BackgroundTaskRuntime completion notifications", () => {
  it("emits one completion event with bounded output preview", async () => {
    const events: BackgroundTaskCompletionEvent[] = [];
    const runtime = new BackgroundTaskRuntime({
      onCompletion: (event) => events.push(event),
      completionPreviewBytes: 10,
    });

    const task = await runtime.start({
      command: `${process.execPath} -e "process.stdout.write('0123456789abcdef')"`,
      cwd: process.cwd(),
      sessionId: "session-1",
    });
    const completed = await runtime.waitFor(task.taskId);

    assert.equal(completed.status, "completed");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.sessionId, "session-1");
    assert.equal(events[0]?.taskId, task.taskId);
    assert.equal(events[0]?.status, "completed");
    assert.equal(events[0]?.exitCode, 0);
    assert.equal(events[0]?.totalBytes, 16);
    assert.equal(events[0]?.outputPreview, "6789abcdef");
    assert.ok(events[0]?.startedAt);
    assert.ok(events[0]?.endedAt);
  });

  it("emits cancelled when a running task is stopped", async () => {
    const events: BackgroundTaskCompletionEvent[] = [];
    const runtime = new BackgroundTaskRuntime({ onCompletion: (event) => events.push(event) });

    const task = await runtime.start({
      command: `${process.execPath} -e "setTimeout(() => {}, 10000)"`,
      cwd: process.cwd(),
      sessionId: "session-2",
    });
    await runtime.stop(task.taskId, { graceMs: 1 });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, "cancelled");
    assert.equal(events[0]?.taskId, task.taskId);
  });
});
