import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadAllTasks, parseTask } from "./taskLoader.js";

const fixtureDir = path.resolve("tests/benchmark/fixtures/tasks");

test("parseTask extracts metadata and sections from a complete task", () => {
  const task = parseTask(`---
id: sanity
name: Sanity Check
category: basic
grading_type: automated
timeout_seconds: 60
---
## Prompt
Say Hello.
## Expected Behavior
The assistant responds.
## Grading Criteria
- [ ] Mentions hello
## Automated Checks
def grade(): return True
`, "sanity.md");

  assert.deepEqual({
    id: task.taskId,
    name: task.name,
    category: task.category,
    gradingType: task.gradingType,
    timeout: task.timeoutSeconds,
  }, {
    id: "sanity",
    name: "Sanity Check",
    category: "basic",
    gradingType: "automated",
    timeout: 60,
  });
  assert.equal(task.prompt, "Say Hello.");
  assert.equal(task.expectedBehavior, "The assistant responds.");
  assert.deepEqual(task.gradingCriteria, ["Mentions hello"]);
  assert.match(task.automatedChecks ?? "", /def grade/);
});

test("parseTask preserves inline workspace file content", () => {
  const task = parseTask(`---
id: inline
name: Inline
category: files
workspace_files:
  - path: data.txt
    content: hello world
---
## Prompt
Read the file.
`, "inline.md");

  assert.deepEqual(task.workspaceFiles, [{ path: "data.txt", content: "hello world" }]);
  assert.equal(task.timeoutSeconds, 120);
});

test("parseTask preserves source assets and hybrid grading weights", () => {
  const task = parseTask(`---
id: asset
name: Asset
category: data
grading_type: hybrid
grading_weights:
  automated: 0.6
  llm_judge: 0.4
workspace_files:
  - source: sales.csv
    dest: input/sales.csv
---
## Prompt
Analyze sales.
`, "asset.md");

  assert.equal(task.gradingType, "hybrid");
  assert.deepEqual(task.gradingWeights, { automated: 0.6, llm_judge: 0.4 });
  assert.deepEqual(task.workspaceFiles, [{ source: "sales.csv", dest: "input/sales.csv" }]);
});

test("loadAllTasks deterministically filters multi-session and unrelated files", async () => {
  const tasks = await loadAllTasks(fixtureDir);

  assert.deepEqual(tasks.map(task => task.taskId), ["alpha", "beta"]);
  assert.equal(tasks[0]?.filePath.endsWith("task_01_alpha.md"), true);
});
