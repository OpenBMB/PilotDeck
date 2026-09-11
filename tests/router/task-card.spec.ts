import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskCard,
  type TaskSnapshot,
} from "../../src/router/index.js";

const NOW = 1_725_500_000_000;

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    approvedPlan: "",
    requiresInitialization: false,
    todos: [],
    activeTodoCount: 0,
    allCompleted: false,
    keyFiles: [],
    ...overrides,
  };
}

test("returns undefined for an undefined snapshot", () => {
  assert.equal(buildTaskCard(undefined, NOW), undefined);
});

test("returns undefined when snapshot has no plan, todos, or keyFiles", () => {
  assert.equal(buildTaskCard(snapshot(), NOW), undefined);
  assert.equal(
    buildTaskCard(snapshot({ approvedPlan: "   \n  \n " }), NOW),
    undefined,
  );
  assert.equal(
    buildTaskCard(snapshot({ todos: [{ content: "  ", status: "pending" }] }), NOW),
    undefined,
  );
  assert.equal(buildTaskCard(snapshot({ keyFiles: ["", "   "] }), NOW), undefined);
});

test("derives goal from the first non-empty plan line", () => {
  const card = buildTaskCard(
    snapshot({ approvedPlan: "\n\n  Refactor the router module  \nsecond line" }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.goal, "Refactor the router module");
});

test("collapses whitespace in the plan goal", () => {
  const card = buildTaskCard(
    snapshot({ approvedPlan: "fix\t the   parser\nnext" }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.goal, "fix the parser");
});

test("caps the plan goal at 600 characters", () => {
  const longWord = "a".repeat(700);
  const card = buildTaskCard(snapshot({ approvedPlan: longWord }), NOW);
  assert.ok(card);
  assert.equal(card.goal?.length, 600);
  assert.equal(card.goal, "a".repeat(600));
});

test("falls back to up to 3 non-empty todo contents joined with '; '", () => {
  const card = buildTaskCard(
    snapshot({
      todos: [
        { content: "", status: "pending" },
        { content: "first task", status: "pending" },
        { content: "  ", status: "in_progress" },
        { content: "second task", status: "pending" },
        { content: "third task", status: "pending" },
        { content: "fourth task", status: "pending" },
      ],
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.goal, "first task; second task; third task");
});

test("caps the todo fallback goal at 600 characters", () => {
  const todos = Array.from({ length: 3 }, () => ({
    content: "b".repeat(400),
    status: "pending" as const,
  }));
  const card = buildTaskCard(snapshot({ todos }), NOW);
  assert.ok(card);
  assert.equal(card.goal?.length, 600);
});

test("prefers the plan over todos for the goal", () => {
  const card = buildTaskCard(
    snapshot({
      approvedPlan: "plan goal",
      todos: [{ content: "todo goal", status: "in_progress" }],
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.goal, "plan goal");
});

test("treats a plan with no non-empty lines as absent and falls back to todos", () => {
  const card = buildTaskCard(
    snapshot({
      approvedPlan: "\n   \n",
      todos: [{ content: "todo goal", status: "pending" }],
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.goal, "todo goal");
});

test("normalizes keyFiles: drops empties, dedupes, keeps first-occurrence order", () => {
  const card = buildTaskCard(
    snapshot({ keyFiles: ["a.ts", "", "b.ts", "a.ts", "  ", "c.ts", "b.ts"] }),
    NOW,
  );
  assert.ok(card);
  assert.deepEqual(card.keyFiles, ["a.ts", "b.ts", "c.ts"]);
});

test("caps keyFiles at 5 items", () => {
  const card = buildTaskCard(
    snapshot({ keyFiles: ["1", "2", "3", "4", "5", "6", "7"] }),
    NOW,
  );
  assert.ok(card);
  assert.deepEqual(card.keyFiles, ["1", "2", "3", "4", "5"]);
});

test("truncates each keyFile to 240 characters", () => {
  const longPath = "x".repeat(300);
  const card = buildTaskCard(snapshot({ keyFiles: [longPath] }), NOW);
  assert.ok(card);
  assert.equal(card.keyFiles.length, 1);
  assert.equal(card.keyFiles[0].length, 240);
  assert.equal(card.keyFiles[0], "x".repeat(240));
});

test("marks taskDone when allCompleted is true", () => {
  const card = buildTaskCard(
    snapshot({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
      ],
      allCompleted: true,
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.taskDone, true);
});

test("marks taskDone when every todo is completed or cancelled", () => {
  const card = buildTaskCard(
    snapshot({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "cancelled" },
      ],
      allCompleted: false,
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.taskDone, true);
});

test("does not mark taskDone with pending todos and no allCompleted signal", () => {
  const card = buildTaskCard(
    snapshot({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
      ],
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.taskDone, false);
});

test("does not mark taskDone with an empty todo list even when allCompleted is true", () => {
  const card = buildTaskCard(snapshot({ allCompleted: true }), NOW);
  assert.equal(card, undefined);
  const withFiles = buildTaskCard(
    snapshot({ allCompleted: true, keyFiles: ["a.ts"] }),
    NOW,
  );
  assert.ok(withFiles);
  assert.equal(withFiles.taskDone, false);
});

test("derives phase understand when requiresInitialization is true", () => {
  const card = buildTaskCard(
    snapshot({
      requiresInitialization: true,
      todos: [{ content: "a", status: "in_progress" }],
      allCompleted: true,
      keyFiles: ["a.ts"],
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.phase, "understand");
  assert.equal(card.taskDone, true);
});

test("derives phase execute when any todo is in_progress", () => {
  const card = buildTaskCard(
    snapshot({
      todos: [
        { content: "a", status: "pending" },
        { content: "b", status: "in_progress" },
      ],
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.phase, "execute");
  assert.equal(card.taskDone, false);
});

test("derives phase verify when todos exist, none in_progress, and task is not done", () => {
  const card = buildTaskCard(
    snapshot({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
      ],
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.phase, "verify");
});

test("leaves phase undefined when todos are all done", () => {
  const card = buildTaskCard(
    snapshot({
      todos: [{ content: "a", status: "completed" }],
      allCompleted: true,
    }),
    NOW,
  );
  assert.ok(card);
  assert.equal(card.phase, undefined);
  assert.equal(card.taskDone, true);
});

test("leaves phase undefined when there are no todos but keyFiles exist", () => {
  const card = buildTaskCard(snapshot({ keyFiles: ["a.ts"] }), NOW);
  assert.ok(card);
  assert.equal(card.phase, undefined);
});

test("uses the provided now value exactly without calling Date.now", () => {
  const card = buildTaskCard(snapshot({ keyFiles: ["a.ts"] }), 42);
  assert.ok(card);
  assert.equal(card.updatedAt, 42);
});
