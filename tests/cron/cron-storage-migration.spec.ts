import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const runEvent = '{"schemaVersion":1,"runId":"run-child","event":{"type":"assistant_text_delta","text":"Report"}}\n';

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

test("new tasks in a parent workspace and a Chinese subproject use separate files", async (t) => {
  const f = await fixture(t);
  const [parentPaths, childPaths] = f.paths;
  for (const [index, projectKey] of [f.parent, f.child].entries()) {
    const registration = join(f.pilotHome, "projects", `registration-${index}`);
    await mkdir(projectKey, { recursive: true });
    await mkdir(registration, { recursive: true });
    await writeFile(join(registration, ".cwd"), projectKey);
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

  await f.manager.start();
  await assert.rejects(f.manager.deleteTask({ taskId }), { code: "cron_task_ambiguous" });
  assert.equal((await f.manager.deleteTask({ taskId, projectKey: f.child })).deleted, true);
  assert.deepEqual((await f.manager.listTasks()).tasks.map(({ projectKey }) => projectKey), [f.parent]);
  const parentRuns = await new CronTaskStore(f.paths[0]).listRuns();
  assert.deepEqual(parentRuns.map(({ runId, projectKey }) => ({ runId, projectKey })), [
    { runId: "copied-run", projectKey: f.parent },
  ]);
  assert.equal(await readFile(targetEvents, "utf8"), runEvent);
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
