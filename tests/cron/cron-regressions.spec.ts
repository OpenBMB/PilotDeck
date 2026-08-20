import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Gateway } from "../../src/gateway/index.js";
import type { CronTask } from "../../src/cron/protocol/types.js";
import { resolveCronPaths } from "../../src/cron/storage/CronPaths.js";
import { CronTaskStore } from "../../src/cron/storage/CronTaskStore.js";
import { CronFire } from "../../src/cron/runtime/CronFire.js";

test("CronTaskStore serializes concurrent writers that share one task file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-cron-concurrency-"));
  try {
    const paths = resolveCronPaths({ pilotHome: root, projectKey: join(root, "project") });
    const tasks = Array.from({ length: 20 }, (_, index) => createTask(`task-${index}`));

    await Promise.all(tasks.map((task) => new CronTaskStore(paths).putTask(task)));

    const stored = await new CronTaskStore(paths).listTasks();
    assert.equal(stored.length, tasks.length);
    assert.deepEqual(
      stored.map((task) => task.taskId).sort(),
      tasks.map((task) => task.taskId).sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CronTaskStore continues queued mutations after one write fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-cron-recovery-"));
  try {
    const paths = resolveCronPaths({ pilotHome: root, projectKey: join(root, "project") });
    const store = new CronTaskStore(paths);
    const writableStore = store as unknown as {
      writeTaskFile: (file: unknown) => Promise<void>;
    };
    const writeTaskFile = writableStore.writeTaskFile.bind(store);
    let failNextWrite = true;
    writableStore.writeTaskFile = async (file) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("injected write failure");
      }
      await writeTaskFile(file);
    };

    const failed = store.putTask(createTask("failed"));
    const recovered = store.putTask(createTask("recovered"));

    await assert.rejects(failed, /injected write failure/);
    await recovered;
    assert.deepEqual((await store.listTasks()).map((task) => task.taskId), ["recovered"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CronFire does not resurrect a task deleted before its run starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-cron-delete-race-"));
  try {
    const paths = resolveCronPaths({ pilotHome: root, projectKey: join(root, "project") });
    const store = new CronTaskStore(paths);
    const calls = {
      submitTurn: 0,
      delivery: 0,
      release: 0,
      phase: 0,
      registered: 0,
      unregistered: 0,
    };
    const activeRuns = new Map<string, { stopRequested: boolean }>();
    const gateway = {
      submitTurn() {
        calls.submitTurn += 1;
        throw new Error("deleted task must not reach the gateway");
      },
    } as unknown as Gateway;
    const fire = new CronFire({
      gateway,
      store,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
      registerActiveRun: (run) => {
        calls.registered += 1;
        activeRuns.set(run.runId, run);
      },
      unregisterActiveRun: (runId) => {
        calls.unregistered += 1;
        const run = activeRuns.get(runId);
        activeRuns.delete(runId);
        return run ? { ...run, runId, taskId: "deleted", sessionKey: "web:s_cron", scheduleType: "once" } : undefined;
      },
      getActiveRun: (runId) => {
        const run = activeRuns.get(runId);
        return run ? { ...run, runId, taskId: "deleted", sessionKey: "web:s_cron", scheduleType: "once" } : undefined;
      },
      runTimeoutMs: 60_000,
      defaultTimezone: "UTC",
      releaseTaskSession: async () => {
        calls.release += 1;
      },
      onResultDelivery: () => {
        calls.delivery += 1;
      },
      onPhaseEvent: () => {
        calls.phase += 1;
      },
    });

    await fire.runTask(createTask("deleted"), "run-deleted");

    assert.equal(calls.submitTurn, 0);
    assert.equal(calls.delivery, 0);
    assert.equal(calls.release, 0);
    assert.equal(calls.phase, 0);
    assert.equal(calls.registered, 1);
    assert.equal(calls.unregistered, 1);
    assert.equal(activeRuns.size, 0);
    assert.deepEqual(await store.listTasks(), []);
    assert.deepEqual(await store.listRuns(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createTask(taskId: string): CronTask {
  return {
    schemaVersion: 1,
    taskId,
    message: `Run ${taskId}`,
    schedule: { type: "once", runAt: "2026-07-09T01:00:00.000Z" },
    status: "scheduled",
    sessionKey: "web:s_cron",
    channelKey: "web",
    projectKey: "/tmp/project",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    nextRunAt: "2026-07-09T01:00:00.000Z",
  };
}
