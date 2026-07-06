import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPlanTodoStateManager } from "../../src/agent/runtime/PlanTodoState.js";
import { createTodoWriteTool, parseTodoMarkdown } from "../../src/tool/builtin/todoWrite.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

function createContext(sessionId = "session-1"): PilotDeckToolRuntimeContext {
  const planTodo = createPlanTodoStateManager().forSession(sessionId);
  return {
    sessionId,
    turnId: "turn-1",
    cwd: "/tmp/workspace",
    permissionMode: "default",
    permissionContext: {
      cwd: "/tmp/workspace",
      mode: "default",
      additionalWorkingDirectories: [],
      bypassAvailable: false,
      canPrompt: false,
      rules: { allow: [], ask: [], deny: [] },
    },
    planTodo,
  };
}

describe("todo_write", () => {
  it("keeps markdown checklist parsing compatible", () => {
    assert.deepEqual(parseTodoMarkdown("- [x] Done\n- [ ] Next\n- [ ] Later"), [
      { id: "todo-1", content: "Done", status: "completed" },
      { id: "todo-2", content: "Next", status: "in_progress" },
      { id: "todo-3", content: "Later", status: "pending" },
    ]);
  });

  it("writes and reads structured todos", async () => {
    const tool = createTodoWriteTool();
    const context = createContext();

    const write = await tool.execute({
      todos: [
        { id: "inspect", content: "Inspect current implementation", status: "completed" },
        { id: "patch", content: "Patch editable todo support", status: "in_progress", priority: "high" },
      ],
      reason: "initial editable plan",
    }, context);

    assert.ok(write.data);
    assert.equal(write.data.mode, "structured");
    assert.equal(write.data.merge, false);
    assert.equal(write.data.reason, "initial editable plan");
    assert.deepEqual(write.data.todos, [
      { id: "inspect", content: "Inspect current implementation", status: "completed" },
      { id: "patch", content: "Patch editable todo support", status: "in_progress", priority: "high" },
    ]);

    const read = await tool.execute({}, context);
    assert.ok(read.data);
    assert.equal(read.data.mode, "read");
    assert.deepEqual(read.data.todos, write.data.todos);
  });

  it("merges structured todo updates by id and appends discovered work", async () => {
    const tool = createTodoWriteTool();
    const context = createContext();

    await tool.execute({
      todos: [
        { id: "inspect", content: "Inspect current implementation", status: "completed" },
        { id: "patch", content: "Patch editable todo support", status: "in_progress" },
      ],
    }, context);

    const merged = await tool.execute({
      merge: true,
      reason: "found verification gap",
      todos: [
        { id: "patch", content: "Patch editable todo support", status: "completed" },
        { id: "verify", content: "Run todo workflow tests", status: "in_progress" },
      ],
    }, context);

    assert.ok(merged.data);
    assert.equal(merged.data.mode, "structured");
    assert.equal(merged.data.merge, true);
    assert.deepEqual(merged.data.todos, [
      { id: "inspect", content: "Inspect current implementation", status: "completed" },
      { id: "patch", content: "Patch editable todo support", status: "completed" },
      { id: "verify", content: "Run todo workflow tests", status: "in_progress" },
    ]);
  });

  it("supports cancelled structured todos", async () => {
    const tool = createTodoWriteTool();
    const context = createContext();

    const result = await tool.execute({
      todos: [
        { id: "obsolete", content: "Use markdown-only updates", status: "cancelled" },
        { id: "structured", content: "Use structured updates", status: "in_progress" },
      ],
    }, context);

    assert.ok(result.data);
    assert.equal(result.data.todos[0]?.status, "cancelled");
    assert.equal(context.planTodo?.getSnapshot().todos[0]?.status, "cancelled");
  });

  it("records todo history and diagnostics for structural changes", async () => {
    const tool = createTodoWriteTool();
    const context = createContext();

    await tool.execute({
      todos: [
        { id: "inspect", content: "Inspect implementation", status: "completed" },
        { id: "patch", content: "Patch implementation", status: "in_progress" },
        { id: "verify", content: "Verify behavior", status: "pending" },
      ],
    }, context);

    const rewrite = await tool.execute({
      reason: "evidence changed the implementation route",
      todos: [
        { id: "new-route", content: "Use revised implementation route", status: "in_progress" },
      ],
    }, context);

    assert.ok(rewrite.data?.diagnostics);
    assert.equal(rewrite.data.diagnostics.writeCount, 2);
    assert.equal(rewrite.data.diagnostics.largeRewriteCount, 1);
    assert.equal(rewrite.data.diagnostics.deletedOpenItemCount, 2);
    assert.equal(rewrite.data.diagnostics.lastWrite?.reason, "evidence changed the implementation route");
    assert.equal(context.planTodo?.getSnapshot().todoHistory.length, 2);
  });

  it("exposes active todos separately from completed and cancelled todos", async () => {
    const tool = createTodoWriteTool();
    const context = createContext();

    await tool.execute({
      todos: [
        { id: "done", content: "Already checked", status: "completed" },
        { id: "skip", content: "Abandoned route", status: "cancelled" },
        { id: "next", content: "Continue useful work", status: "pending" },
      ],
    }, context);

    assert.deepEqual(context.planTodo?.getSnapshot().activeTodos, [
      { id: "next", content: "Continue useful work", status: "pending" },
    ]);
  });

  it("does not put completed or cancelled todos in active todo context", async () => {
    const planTodo = createPlanTodoStateManager().forSession("plan-session");
    planTodo.markPlanApproved("approved plan");
    planTodo.writeTodos([
      { id: "done", content: "Completed work", status: "completed" },
      { id: "old", content: "Cancelled route", status: "cancelled" },
      { id: "now", content: "Current work", status: "in_progress" },
    ]);

    const snapshot = planTodo.getSnapshot();
    assert.deepEqual(snapshot.activeTodos, [
      { id: "now", content: "Current work", status: "in_progress" },
    ]);
    assert.equal(snapshot.todoHistory.length, 1);
    assert.equal(snapshot.todoDiagnostics.cancelledCount, 1);
  });

  it("flags all-completed updates after active work", async () => {
    const tool = createTodoWriteTool();
    const context = createContext();

    await tool.execute({
      todos: [
        { id: "build", content: "Build output", status: "in_progress" },
        { id: "verify", content: "Verify output", status: "pending" },
      ],
    }, context);
    const done = await tool.execute({
      merge: true,
      todos: [
        { id: "build", content: "Build output", status: "completed" },
        { id: "verify", content: "Verify output", status: "completed" },
      ],
    }, context);

    assert.equal(done.data?.diagnostics?.completedWithoutActiveCount, 1);
    assert.equal(done.data?.diagnostics?.lastWrite?.allCompleted, true);
  });
});
