import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCronManager, createCronRuntime, cronRunEventsPath, CronTaskStore, defaultCronConfig, resolveCronPaths,
} from "../../src/cron/index.js";
import type { CronRunRecord, CronTask } from "../../src/cron/protocol/types.js";
import { migrateCronStores } from "../../src/cron/storage/CronStoreMigration.js";
import type { Gateway } from "../../src/gateway/index.js";
import { createProjectId } from "../../src/pilot/paths.js";

const timestamp = "2026-06-01T08:00:00.000Z";
const nextRunAt = "2026-06-02T08:00:00.000Z";
const runEvent = ["ha", "ha", "!"].map((text) => JSON.stringify({
  schemaVersion: 1, runId: "run-child", event: { type: "assistant_text_delta", text },
})).join("\n") + "\n";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-cron-stores-"));
  const pilotHome = join(root, "state");
  const parent = join(root, "workspace");
  const child = join(parent, "项目甲");
  const sibling = join(parent, "项目乙");
  assert.equal(createProjectId(parent), createProjectId(child));
  assert.equal(createProjectId(parent), createProjectId(sibling));
  const legacyDir = join(pilotHome, "cron", "projects", createProjectId(parent));
  const legacyTasks = join(legacyDir, "tasks.json");
  const legacyEvents = join(legacyDir, "runs", "run-child.events.jsonl");
  const paths = [parent, child, sibling].map((projectKey) => resolveCronPaths({ pilotHome, projectKey }));
  const overrides = { pilotHome, config: defaultCronConfig(), now: () => new Date(timestamp) };
  const manager = createCronManager(overrides);
  manager.bindGateway({
    closeSession: async () => {},
    async *submitTurn() { assert.fail("The migration must not execute a task"); },
  } as unknown as Gateway);
  t.after(async () => {
    try { await manager.stop(); } finally { await rm(root, { force: true, recursive: true }); }
  });
  return { pilotHome, parent, child, paths, legacyDir, legacyTasks, legacyEvents, overrides, manager };
}

function task(taskId: string, projectKey?: string): CronTask {
  return {
    schemaVersion: 1,
    taskId,
    projectKey,
    message: "Synthetic report",
    executionMode: "persistent",
    sessionKey: `cron:${taskId}`,
    channelKey: "cron",
    schedule: { type: "once", runAt: nextRunAt },
    status: "scheduled",
    nextRunAt,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function registerProject(pilotHome: string, id: string, projectKey: string): Promise<void> {
  const registration = join(pilotHome, "projects", id);
  await mkdir(registration, { recursive: true });
  await writeFile(join(registration, ".cwd"), projectKey);
}

test("case aliases of an existing project share one runtime and allow scoped deletion", async (t) => {
  const f = await fixture(t);
  const registered = join(f.parent, "Workspace");
  const alias = join(f.parent, "workspace");
  await mkdir(registered, { recursive: true });
  if (!await stat(alias).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })) {
    t.skip("The test workspace uses case-sensitive paths");
    return;
  }
  await registerProject(f.pilotHome, "workspace", registered);
  await f.manager.start();
  const schedule = { type: "once" as const, runAt: nextRunAt };
  const { task: original } = await f.manager.createTask({ projectKey: registered, message: "Report", schedule });
  assert.equal((await f.manager.deleteTask({ taskId: original.taskId, projectKey: alias, stopRunning: true })).deleted, true);

  const { task: created } = await f.manager.createTask({ projectKey: alias, message: "Report", schedule });
  assert.equal(created.projectKey, registered);
  assert.equal(resolveCronPaths({ pilotHome: f.pilotHome, projectKey: alias }).tasksFile,
    resolveCronPaths({ pilotHome: f.pilotHome, projectKey: registered }).tasksFile);
  assert.deepEqual((await f.manager.listTasks({ projectKey: alias })).tasks.map(({ taskId }) => taskId), [created.taskId]);
  assert.deepEqual((await f.manager.listTasks()).tasks.map(({ taskId }) => taskId), [created.taskId]);
  const update = await f.manager.updateTask({ taskId: created.taskId, projectKey: alias,
    expectedRevision: created.revision!, message: "Updated report", schedule });
  assert.equal(update.updated, true);
});

test("renaming an active project by case keeps scoped operations on the loaded store", async (t) => {
  const f = await fixture(t);
  const original = join(f.parent, "Workspace");
  const renamed = join(f.parent, "workspace");
  await mkdir(original, { recursive: true });
  if (!await stat(renamed).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })) {
    t.skip("The test workspace uses case-sensitive paths");
    return;
  }
  await registerProject(f.pilotHome, "original-project", original);
  await f.manager.start();
  const schedule = { type: "once" as const, runAt: nextRunAt };
  const oldPaths = resolveCronPaths({ pilotHome: f.pilotHome, projectKey: original });
  const { task: existing } = await f.manager.createTask({ projectKey: original, message: "Original report", schedule });

  const intermediate = join(f.parent, "case-rename");
  await rename(original, intermediate);
  await rename(intermediate, renamed);
  const newPaths = resolveCronPaths({ pilotHome: f.pilotHome, projectKey: renamed });
  assert.notEqual(oldPaths.tasksFile, newPaths.tasksFile);
  assert.deepEqual((await f.manager.listTasks()).tasks.map(({ taskId }) => taskId), [existing.taskId]);
  for (const projectKey of [existing.projectKey, renamed]) {
    assert.deepEqual((await f.manager.listTasks({ projectKey })).tasks.map(({ taskId }) => taskId), [existing.taskId]);
  }
  await registerProject(f.pilotHome, "renamed-project", renamed);
  const { task: added } = await f.manager.createTask({ projectKey: renamed, message: "New report", schedule });
  assert.deepEqual((await new CronTaskStore(oldPaths).listTasks()).map(({ taskId }) => taskId).sort(),
    [existing.taskId, added.taskId].sort());
  assert.equal((await f.manager.deleteTask({ taskId: existing.taskId, projectKey: existing.projectKey, stopRunning: true })).deleted, true);
  assert.deepEqual((await f.manager.listTasks()).tasks.map(({ taskId }) => taskId), [added.taskId]);
  await assert.rejects(readFile(newPaths.tasksFile), { code: "ENOENT" });

  await f.manager.stop();
  await f.manager.start();
  assert.deepEqual((await f.manager.listTasks({ projectKey: renamed })).tasks.map(({ taskId }) => taskId), [added.taskId]);
  assert.deepEqual((await new CronTaskStore(oldPaths).listTasks()).map(({ taskId }) => taskId), []);
  assert.deepEqual((await new CronTaskStore(newPaths).listTasks()).map(({ taskId }) => taskId), [added.taskId]);
});

test("case-distinct directories remain separate projects on a case-sensitive filesystem", async (t) => {
  const f = await fixture(t);
  const upper = join(f.parent, "Workspace");
  const lower = join(f.parent, "workspace");
  await mkdir(upper, { recursive: true });
  try { await mkdir(lower); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    t.skip("The test workspace uses case-insensitive paths");
    return;
  }
  await registerProject(f.pilotHome, "uppercase", upper);
  await registerProject(f.pilotHome, "lowercase", lower);
  await f.manager.start();
  const schedule = { type: "once" as const, runAt: nextRunAt };
  const { task: upperTask } = await f.manager.createTask({ projectKey: upper, message: "Upper project", schedule });
  const { task: lowerTask } = await f.manager.createTask({ projectKey: lower, message: "Lower project", schedule });
  assert.equal((await f.manager.deleteTask({ taskId: upperTask.taskId, projectKey: lower, stopRunning: true })).deleted, false);
  assert.equal((await f.manager.deleteTask({ taskId: lowerTask.taskId, projectKey: lower })).deleted, true);
  assert.deepEqual((await f.manager.listTasks()).tasks.map(({ taskId }) => taskId), [upperTask.taskId]);
});

test("startup migrates a previously hashed path alias with its run events", async (t) => {
  const f = await fixture(t);
  const registered = join(f.parent, "Workspace");
  const alias = join(f.parent, "workspace");
  await mkdir(registered, { recursive: true });
  if (!await stat(alias).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  })) {
    t.skip("The test workspace uses case-sensitive paths");
    return;
  }
  const previousDir = join(f.pilotHome, "cron", "projects", `v2~${createHash("sha256").update(alias).digest("hex")}`);
  const aliasTask = task("alias", alias);
  const savedRun: CronRunRecord = {
    schemaVersion: 1, taskId: aliasTask.taskId, runId: "run-child", sessionKey: aliasTask.sessionKey,
    startedAt: timestamp, finishedAt: timestamp, outcome: "completed",
  };
  await mkdir(join(previousDir, "runs"), { recursive: true });
  await writeFile(join(previousDir, "tasks.json"), JSON.stringify({ schemaVersion: 1, tasks: [aliasTask] }));
  await writeFile(join(previousDir, "run-history.jsonl"), `${JSON.stringify(savedRun)}\n`);
  await writeFile(join(previousDir, "runs", "run-child.events.jsonl"), runEvent);

  await f.manager.start();
  const history = await f.manager.listTasks({ projectKey: registered, taskId: aliasTask.taskId, includeHistory: true });
  assert.deepEqual(history.tasks.map(({ taskId }) => taskId), [aliasTask.taskId]);
  assert.deepEqual(history.recentRuns?.map(({ runId }) => runId), [savedRun.runId]);
  const paths = resolveCronPaths({ pilotHome: f.pilotHome, projectKey: registered });
  assert.equal(await readFile(cronRunEventsPath(paths, savedRun.runId), "utf8"), runEvent);
  assert.deepEqual(JSON.parse(await readFile(join(previousDir, "tasks.json"), "utf8")).tasks, []);
  assert.equal((await f.manager.deleteTask({ taskId: aliasTask.taskId, projectKey: registered })).deleted, true);
});

test("new tasks in a parent workspace and a Chinese subproject use separate files", async (t) => {
  const f = await fixture(t);
  const [parentPaths, childPaths] = f.paths;
  for (const [index, projectKey] of [f.parent, f.child].entries()) {
    await mkdir(projectKey, { recursive: true });
    await registerProject(f.pilotHome, `registration-${index}`, projectKey);
  }
  await f.manager.start();
  const schedule = { type: "once" as const, runAt: nextRunAt };
  const { task: parentTask } = await f.manager.createTask({ projectKey: f.parent, message: "Parent report", schedule });
  const { task: childTask } = await f.manager.createTask({ projectKey: f.child, message: "Child report", schedule });

  assert.deepEqual((await new CronTaskStore(parentPaths).listTasks()).map(({ taskId }) => taskId), [parentTask.taskId]);
  assert.deepEqual((await new CronTaskStore(childPaths).listTasks()).map(({ taskId }) => taskId), [childTask.taskId]);
  assert.equal((await f.manager.deleteTask({ taskId: childTask.taskId, projectKey: f.child })).deleted, true);
  assert.deepEqual((await f.manager.listTasks()).tasks.map(({ taskId }) => taskId), [parentTask.taskId]);
});

test("startup splits a legacy store shared by parent and Chinese subprojects and deletes only the selected task", async (t) => {
  const f = await fixture(t);
  const [parentPaths, childPaths, siblingPaths] = f.paths;
  assert.equal(new Set(f.paths.map(({ tasksFile }) => tasksFile)).size, 3);
  const parentTask: CronTask = { ...task("parent", f.parent), status: "completed", enabled: false, nextRunAt: undefined };
  const childTask = task("child", f.child);
  const siblingTask = task("sibling", siblingPaths.projectKey);
  const ambiguousTask = task("owner-unknown");
  const savedRun: CronRunRecord = {
    schemaVersion: 1, taskId: childTask.taskId, runId: "run-child", sessionKey: childTask.sessionKey,
    startedAt: timestamp, finishedAt: timestamp, outcome: "completed",
  };
  await mkdir(join(f.legacyDir, "runs"), { recursive: true });
  await writeFile(f.legacyTasks, JSON.stringify({ schemaVersion: 1, tasks: [parentTask, childTask, siblingTask, ambiguousTask] }));
  await writeFile(join(f.legacyDir, ".cwd"), f.child);
  await writeFile(join(f.legacyDir, "run-history.jsonl"), `${JSON.stringify(savedRun)}\n`);
  await writeFile(f.legacyEvents, runEvent);
  await f.manager.start();

  const { tasks } = await f.manager.listTasks();
  assert.deepEqual(tasks.map(({ taskId }) => taskId).sort(), ["child", "parent", "sibling"]);
  assert.equal(tasks.find(({ taskId }) => taskId === "parent")?.status, "completed");
  assert.equal(tasks.find(({ taskId }) => taskId === "child")?.nextRunAt, nextRunAt);
  assert.deepEqual(JSON.parse(await readFile(f.legacyTasks, "utf8")).tasks, [JSON.parse(JSON.stringify(ambiguousTask))]);
  const childHistory = await f.manager.listTasks({ projectKey: f.child, taskId: "child", includeHistory: true });
  assert.deepEqual(childHistory.recentRuns?.map(({ runId }) => runId), [savedRun.runId]);
  assert.equal(await readFile(cronRunEventsPath(childPaths, savedRun.runId), "utf8"), runEvent);
  await assert.rejects(readFile(f.legacyEvents, "utf8"), { code: "ENOENT" });

  const originalParent = await readFile(parentPaths.tasksFile, "utf8");
  assert.equal((await f.manager.deleteTask({ taskId: "child", projectKey: f.parent, stopRunning: true })).deleted, false);
  assert.equal((await f.manager.deleteTask({ taskId: "child", projectKey: f.child, stopRunning: true })).deleted, true);
  assert.equal(await readFile(parentPaths.tasksFile, "utf8"), originalParent);
  assert.equal((await f.manager.deleteTask({ taskId: "sibling" })).deleted, true);

  await f.manager.stop();
  await f.manager.start();
  assert.deepEqual((await f.manager.listTasks()).tasks.map(({ taskId }) => taskId), ["parent"]);
  assert.equal(await readFile(cronRunEventsPath(childPaths, savedRun.runId), "utf8"), runEvent);
});

test("an interrupted migration preserves both source owners and resumes before allowing scoped deletion", async (t) => {
  const f = await fixture(t);
  const [, childPaths] = f.paths;
  const taskId = "copied-task";
  const tasks = [task(taskId, f.parent), task(taskId, f.child)];
  const source = JSON.stringify({ schemaVersion: 1, tasks });
  const history = join(f.legacyDir, "run-history.jsonl");
  const copiedRun = {
    schemaVersion: 1, taskId, runId: "copied-run", sessionKey: tasks[0].sessionKey,
    startedAt: timestamp, finishedAt: timestamp,
  };
  const sourceRuns = [
    { ...copiedRun, projectKey: f.parent },
    { ...copiedRun, projectKey: f.child },
    { ...copiedRun, projectKey: f.child, runId: "run-child" },
  ].map((run) => JSON.stringify(run)).join("\n") + "\n";
  const targetEvents = cronRunEventsPath(childPaths, "run-child");
  await mkdir(join(f.legacyDir, "runs"), { recursive: true });
  await writeFile(f.legacyTasks, source);
  await writeFile(f.legacyEvents, runEvent);
  await writeFile(history, sourceRuns);

  // Blocking the event destination makes migration fail after staging tasks.
  await mkdir(targetEvents, { recursive: true });
  await assert.rejects(migrateCronStores({ pilotHome: f.pilotHome }));
  assert.equal(await readFile(f.legacyTasks, "utf8"), source);
  assert.equal(await readFile(history, "utf8"), sourceRuns);
  assert.equal(await readFile(f.legacyEvents, "utf8"), runEvent);
  assert.deepEqual(JSON.parse(await readFile(childPaths.tasksFile, "utf8")).tasks, [tasks[1]]);
  await rm(targetEvents, { recursive: true });
  // Simulate a prior attempt that updated the event file before clearing its source.
  const previousEvent = '{"schemaVersion":1,"runId":"run-child","event":{"type":"assistant_text_delta","text":"Start"}}\n';
  await writeFile(targetEvents, previousEvent + runEvent);

  await f.manager.start();
  await assert.rejects(f.manager.deleteTask({ taskId }), { code: "cron_task_ambiguous" });
  assert.equal((await f.manager.deleteTask({ taskId, projectKey: f.child })).deleted, true);
  assert.deepEqual((await f.manager.listTasks()).tasks.map(({ projectKey }) => projectKey), [f.parent]);
  const parentRuns = await new CronTaskStore(f.paths[0]).listRuns();
  assert.deepEqual(parentRuns.map(({ runId, projectKey }) => ({ runId, projectKey })), [
    { runId: "copied-run", projectKey: f.parent },
  ]);
  assert.equal(await readFile(targetEvents, "utf8"), previousEvent + runEvent);
});

test("a task recorded under another project is protected even if it is misplaced in the selected store", async (t) => {
  const f = await fixture(t);
  const store = new CronTaskStore(f.paths[0]);
  await store.putTask(task("misplaced", f.child));
  const runtime = createCronRuntime({ ...f.overrides, projectKey: f.parent, store });
  assert.equal(await runtime.hasTask("misplaced"), false);
  assert.deepEqual(await runtime.deleteTask({ taskId: "misplaced", projectKey: f.parent, stopRunning: true }), { deleted: false });
  assert.equal((await runtime.deleteTask({ taskId: "misplaced" })).deleted, false);
  assert.equal((await store.listTasks()).length, 1);
});
