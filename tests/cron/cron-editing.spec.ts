import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCronRuntime, defaultCronConfig } from "../../src/cron/index.js";
import type { CronTask, CronUpdateInput } from "../../src/cron/protocol/types.js";
import { CronFire } from "../../src/cron/runtime/CronFire.js";
import { computeNextCronRunAt } from "../../src/cron/runtime/CronSchedule.js";
import { CronScheduler } from "../../src/cron/runtime/CronScheduler.js";
import { resolveCronPaths } from "../../src/cron/storage/CronPaths.js";
import { CronTaskStore } from "../../src/cron/storage/CronTaskStore.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { RemoteGateway } from "../../src/gateway/client/RemoteGateway.js";
import type { GatewayWsClient } from "../../src/gateway/client/GatewayWsClient.js";
import type { Gateway, GatewayCronController, GatewayEvent } from "../../src/gateway/index.js";
import { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/protocol/version.js";
import { GatewayWsConnection } from "../../src/gateway/server/GatewayWsConnection.js";
import type { TextWebSocketConnection } from "../../src/gateway/server/websocket.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import { GatewayBrowserClient } from "../../src/web/client/GatewayBrowserClient.js";
import type { WebGatewayMethod } from "../../src/web/client/protocol.js";

function createStore(pilotHome: string, projectKey: string): CronTaskStore {
  return new CronTaskStore(resolveCronPaths({ pilotHome, projectKey }));
}

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    schemaVersion: 1,
    taskId: "task-1",
    message: "Run the report",
    schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
    status: "scheduled",
    sessionKey: "cron:task-1",
    channelKey: "cron",
    projectKey: "/tmp/projects/cron-editing",
    timezone: "UTC",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    scheduleComputationVersion: 2,
    ...overrides,
  };
}

function createFire(
  store: CronTaskStore,
  gateway: Gateway,
  now: () => Date,
  onTurnEvent?: (sessionKey: string, channelKey: string, event: GatewayEvent) => void,
): CronFire {
  const activeRuns = new Map<string, { runId: string; taskId: string; sessionKey: string; scheduleType: "once" | "cron"; stopRequested: boolean }>();
  return new CronFire({
    gateway,
    store,
    now,
    registerActiveRun: (run) => activeRuns.set(run.runId, run),
    unregisterActiveRun: (runId) => {
      const run = activeRuns.get(runId);
      activeRuns.delete(runId);
      return run;
    },
    getActiveRun: (runId) => activeRuns.get(runId),
    runTimeoutMs: 60_000,
    defaultTimezone: "UTC",
    releaseTaskSession: async () => undefined,
    onTurnEvent,
  });
}

class FakeTextWebSocketConnection {
  readonly sent: unknown[] = [];
  private messageHandler?: (message: string) => void;

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(_handler: () => void): void {}

  sendText(message: string): void {
    this.sent.push(JSON.parse(message));
  }

  close(): void {}

  dispatch(frame: unknown): void {
    this.messageHandler?.(JSON.stringify(frame));
  }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("CronTaskStore normalizes legacy tasks without a revision to zero", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-legacy-revision-"));
  const projectKey = "/tmp/projects/cron-editing";
  try {
    const store = createStore(pilotHome, projectKey);
    await store.putTask(makeTask({ revision: undefined }));
    assert.equal((await store.getTask("task-1"))?.revision, 0);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("CronSchedule finds the next February 29 in the task timezone", () => {
  assert.equal(
    computeNextCronRunAt("30 8 29 2 *", new Date("2026-01-01T00:00:00.000Z"), "Asia/Shanghai")?.toISOString(),
    "2028-02-29T00:30:00.000Z",
  );
});

test("CronRuntime updates a task in place and rejects running or stale updates", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-editing-"));
  const projectKey = "/tmp/projects/cron-editing";
  let now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const store = createStore(pilotHome, projectKey);
    const runtime = createCronRuntime({
      config: defaultCronConfig(),
      pilotHome,
      projectKey,
      store,
      now: () => now,
      uuid: () => "task-1",
      skipToolCreation: true,
    });
    const created = await runtime.createTask({
      message: "Original prompt",
      projectKey,
      timezone: "Asia/Shanghai",
      schedule: { type: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" },
    });
    assert.equal(created.task.revision, 0);
    await store.appendRun({
      schemaVersion: 1,
      runId: "historic-run",
      taskId: created.task.taskId,
      sessionKey: created.task.sessionKey,
      projectKey,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      outcome: "completed",
    });

    now = new Date("2026-01-03T00:00:00.000Z");
    const updated = await runtime.updateTask({
      taskId: created.task.taskId,
      projectKey,
      expectedRevision: 0,
      message: "Updated prompt",
      timezone: "America/New_York",
      schedule: { type: "once", runAt: "2026-02-01T13:30:00.000Z" },
    });
    assert.equal(updated.updated, true);
    if (!updated.updated) return;
    assert.equal(updated.task.taskId, created.task.taskId);
    assert.equal(updated.task.createdAt, created.task.createdAt);
    assert.equal(updated.task.sessionKey, created.task.sessionKey);
    assert.equal(updated.task.message, "Updated prompt");
    assert.equal(updated.task.timezone, "America/New_York");
    assert.equal(updated.task.revision, 1);
    assert.deepEqual(updated.task.schedule, { type: "once", runAt: "2026-02-01T13:30:00.000Z" });
    assert.equal((await runtime.listTasks({ includeHistory: true })).recentRuns?.[0]?.runId, "historic-run");

    assert.deepEqual(await runtime.updateTask({
      taskId: created.task.taskId,
      projectKey,
      expectedRevision: 0,
      message: "Stale prompt",
      schedule: { type: "once", runAt: "2026-02-02T13:30:00.000Z" },
    }), { updated: false, reason: "conflict" });
    assert.deepEqual(await runtime.updateTask({
      taskId: created.task.taskId,
      projectKey: "/tmp/projects/another-project",
      expectedRevision: 1,
      message: "Wrong workspace",
      schedule: { type: "once", runAt: "2026-02-02T13:30:00.000Z" },
    }), { updated: false, reason: "not_found" });
    await assert.rejects(runtime.updateTask({
      taskId: created.task.taskId,
      projectKey,
      expectedRevision: 1,
      message: "Invalid timezone",
      timezone: "Not/AZone",
      schedule: { type: "once", runAt: "2026-02-02T13:30:00.000Z" },
    }), /Invalid Cron timezone/);
    assert.equal((await store.getTask(created.task.taskId))?.revision, 1);
    assert.equal((await store.getTask(created.task.taskId))?.timezone, "America/New_York");

    await store.updateTask(created.task.taskId, (current) => ({
      ...current,
      status: "running",
      lastRunId: "active-run",
      revision: (current.revision ?? 0) + 1,
    }));
    assert.deepEqual(await runtime.updateTask({
      taskId: created.task.taskId,
      projectKey,
      expectedRevision: 2,
      message: "Cannot edit while running",
      schedule: { type: "once", runAt: "2026-02-03T13:30:00.000Z" },
    }), { updated: false, reason: "running" });
    await assert.rejects(runtime.updateTask({
      taskId: created.task.taskId,
      projectKey,
      expectedRevision: 2,
      message: "   ",
      schedule: { type: "once", runAt: "2026-02-03T13:30:00.000Z" },
    }), /message is required/);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("CronRuntime updates daily, weekly, monthly, yearly, and one-time schedules in place", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-editing-schedules-"));
  const projectKey = "/tmp/projects/cron-editing-schedules";
  const now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const runtime = createCronRuntime({
      config: defaultCronConfig(),
      pilotHome,
      projectKey,
      now: () => now,
      uuid: () => "task-schedules",
      skipToolCreation: true,
    });
    const created = await runtime.createTask({
      message: "Original",
      projectKey,
      timezone: "UTC",
      schedule: { type: "once", runAt: "2026-01-02T12:00:00.000Z" },
    });
    const cases: Array<{ schedule: CronUpdateInput["schedule"]; nextRunAt: string }> = [
      { schedule: { type: "cron", expression: "30 8 * * *", timezone: "UTC" }, nextRunAt: "2026-01-01T08:30:00.000Z" },
      { schedule: { type: "cron", expression: "30 8 * * 1", timezone: "UTC" }, nextRunAt: "2026-01-05T08:30:00.000Z" },
      { schedule: { type: "cron", expression: "30 8 15 * *", timezone: "UTC" }, nextRunAt: "2026-01-15T08:30:00.000Z" },
      { schedule: { type: "cron", expression: "30 8 15 9 *", timezone: "UTC" }, nextRunAt: "2026-09-15T08:30:00.000Z" },
      { schedule: { type: "cron", expression: "30 8 29 2 *", timezone: "UTC" }, nextRunAt: "2028-02-29T08:30:00.000Z" },
      { schedule: { type: "once", runAt: "2026-01-02T12:00:00.000Z" }, nextRunAt: "2026-01-02T12:00:00.000Z" },
    ];

    let revision = 0;
    for (const [index, scheduleCase] of cases.entries()) {
      const result = await runtime.updateTask({
        taskId: created.task.taskId,
        projectKey,
        expectedRevision: revision,
        message: `Updated ${index + 1}`,
        schedule: scheduleCase.schedule,
        timezone: "UTC",
      });
      assert.equal(result.updated, true);
      if (!result.updated) continue;
      revision += 1;
      assert.equal(result.task.taskId, created.task.taskId);
      assert.equal(result.task.createdAt, created.task.createdAt);
      assert.equal(result.task.sessionKey, created.task.sessionKey);
      assert.equal(result.task.revision, revision);
      assert.equal(result.task.nextRunAt, scheduleCase.nextRunAt);
      assert.deepEqual(result.task.schedule, scheduleCase.schedule);
      assert.equal(result.task.scheduleComputationVersion, scheduleCase.schedule.type === "cron" ? 2 : undefined);
    }
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("CronRuntime checks the persisted task workspace inside the atomic update", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-editing-project-"));
  const projectKey = "/tmp/projects/cron-editing-project";
  try {
    const store = createStore(pilotHome, projectKey);
    await store.putTask(makeTask({ projectKey: "/tmp/projects/another-project" }));
    const runtime = createCronRuntime({
      config: defaultCronConfig(),
      pilotHome,
      projectKey,
      store,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      skipToolCreation: true,
    });
    assert.deepEqual(await runtime.updateTask({
      taskId: "task-1",
      projectKey,
      expectedRevision: 0,
      message: "Must not move workspaces",
      schedule: { type: "cron", expression: "30 8 * * *", timezone: "UTC" },
      timezone: "UTC",
    }), { updated: false, reason: "not_found" });
    assert.equal((await store.getTask("task-1"))?.projectKey, "/tmp/projects/another-project");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("CronFire never executes an edited snapshot and claims a current snapshot only once", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-claim-"));
  const projectKey = "/tmp/projects/cron-editing";
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  try {
    const store = createStore(pilotHome, projectKey);
    const oldSnapshot = makeTask();
    await store.putTask(oldSnapshot);
    let submitCount = 0;
    const gateway = {
      submitTurn: async function* () {
        submitCount += 1;
      },
    } as unknown as Gateway;
    const fire = createFire(store, gateway, now);

    await store.updateTask(oldSnapshot.taskId, (current) => ({
      ...current,
      message: "Edited before execution",
      schedule: { type: "cron", expression: "15 * * * *", timezone: "UTC" },
      nextRunAt: "2026-01-01T00:15:00.000Z",
      revision: (current.revision ?? 0) + 1,
    }));
    await fire.runTask(oldSnapshot, "old-run");
    assert.equal(submitCount, 0);
    assert.equal((await store.getTask(oldSnapshot.taskId))?.message, "Edited before execution");

    const current = await store.getTask(oldSnapshot.taskId);
    assert.ok(current);
    await Promise.all([fire.runTask(current, "run-a"), fire.runTask(current, "run-b")]);
    assert.equal(submitCount, 1);
    const completed = await store.getTask(oldSnapshot.taskId);
    assert.equal(completed?.status, "scheduled");
    assert.equal(completed?.revision, 3);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("CronFire forwards live gateway events", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-turn-events-"));
  const projectKey = "/tmp/projects/cron-editing";
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  try {
    const store = createStore(pilotHome, projectKey);
    const task = makeTask();
    await store.putTask(task);
    const gatewayEvents: GatewayEvent[] = [
      { type: "assistant_text_delta", text: "Working" },
      { type: "turn_completed", usage: {}, finishReason: "completed" },
    ];
    const gateway = {
      submitTurn: async function* () {
        yield* gatewayEvents;
      },
    } as unknown as Gateway;
    const forwarded: Array<{ sessionKey: string; channelKey: string; event: GatewayEvent }> = [];
    const fire = createFire(store, gateway, now, (sessionKey, channelKey, event) => {
      forwarded.push({ sessionKey, channelKey, event });
    });

    await fire.runTask(task, "run-1");

    assert.deepEqual(forwarded, gatewayEvents.map((event) => ({
      sessionKey: task.sessionKey,
      channelKey: task.channelKey,
      event,
    })));
    assert.equal((await store.getTask(task.taskId))?.status, "scheduled");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("CronFire completes when live event forwarding fails", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-cron-turn-events-failure-"));
  const projectKey = "/tmp/projects/cron-editing";
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  try {
    const store = createStore(pilotHome, projectKey);
    const task = makeTask();
    await store.putTask(task);
    const gateway = {
      submitTurn: async function* () {
        yield { type: "assistant_text_delta", text: "Working" } as GatewayEvent;
        yield { type: "turn_completed", usage: {}, finishReason: "completed" } as GatewayEvent;
      },
    } as unknown as Gateway;
    const warnings: string[] = [];
    const fire = new CronFire({
      gateway,
      store,
      now,
      registerActiveRun: () => undefined,
      unregisterActiveRun: () => undefined,
      getActiveRun: () => undefined,
      runTimeoutMs: 60_000,
      defaultTimezone: "UTC",
      releaseTaskSession: async () => undefined,
      onTurnEvent: () => {
        throw new Error("notification unavailable");
      },
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    await fire.runTask(task, "run-1");

    assert.equal((await store.getTask(task.taskId))?.status, "scheduled");
    assert.ok(warnings.includes("cron turn event delivery failed"));
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("CronScheduler does not delay a task after the task was edited", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const staleSnapshot = makeTask({ nextRunAt: now.toISOString() });
  let currentTask = makeTask({
    message: "Edited schedule",
    nextRunAt: "2026-01-01T01:00:00.000Z",
    revision: 1,
  });
  const store = {
    listTasks: async () => [{ ...staleSnapshot }],
    updateTask: async (_taskId: string, update: (task: CronTask) => CronTask | undefined) => {
      const updated = update(currentTask);
      if (updated) currentTask = updated;
      return updated;
    },
  } as unknown as CronTaskStore;
  const scheduler = new CronScheduler({
    config: { ...defaultCronConfig(), maxConcurrentRuns: 1 },
    store,
    fire: { runTask: async () => undefined } as unknown as CronFire,
    uuid: () => "run-1",
    now: () => now,
    activeRunCount: () => 1,
  });

  await scheduler.runTickOnce();
  assert.equal(currentTask.message, "Edited schedule");
  assert.equal(currentTask.nextRunAt, "2026-01-01T01:00:00.000Z");
  assert.equal(currentTask.revision, 1);
});

test("Cron update is forwarded by gateway dispatchers and clients", async () => {
  const input: CronUpdateInput = {
    taskId: "task-1",
    projectKey: "/tmp/projects/cron-editing",
    expectedRevision: 0,
    message: "Updated",
    schedule: { type: "cron", expression: "30 8 * * 1", timezone: "UTC" },
    timezone: "UTC",
  };
  const expected = { updated: false as const, reason: "not_found" as const };
  let inProcessInput: CronUpdateInput | undefined;
  const controller = {
    updateTask: async (received: CronUpdateInput) => {
      inProcessInput = received;
      return expected;
    },
  } as unknown as GatewayCronController;
  const inProcess = new InProcessGateway({} as SessionRouter, { cron: controller });
  assert.deepEqual(await inProcess.cronUpdate(input), expected);
  assert.deepEqual(inProcessInput, input);

  let remoteMethod: string | undefined;
  let remoteInput: unknown;
  const remote = new RemoteGateway({
    request: async (method: string, received: unknown) => {
      remoteMethod = method;
      remoteInput = received;
      return expected;
    },
  } as unknown as GatewayWsClient);
  assert.deepEqual(await remote.cronUpdate(input), expected);
  assert.equal(remoteMethod, "cron_update");
  assert.deepEqual(remoteInput, input);

  let websocketInput: CronUpdateInput | undefined;
  const socket = new FakeTextWebSocketConnection();
  new GatewayWsConnection(socket as unknown as TextWebSocketConnection, {
    token: "secret",
    serverVersion: "test",
    gateway: {
      describeServer: async () => ({ mode: "in_process" }),
      cronUpdate: async (received: CronUpdateInput) => {
        websocketInput = received;
        return expected;
      },
    } as unknown as Gateway,
  });
  socket.dispatch({
    type: "hello",
    protocolVersion: PILOTDECK_GATEWAY_PROTOCOL_VERSION,
    clientName: "test",
    clientVersion: "test",
    token: "secret",
  });
  await flushAsyncWork();
  socket.dispatch({ type: "request", id: "cron-update-1", method: "cron_update", params: input });
  await flushAsyncWork();
  assert.deepEqual(websocketInput, input);
  assert.deepEqual(socket.sent.at(-1), {
    type: "response",
    id: "cron-update-1",
    ok: true,
    result: expected,
  });

  const browserMethod: WebGatewayMethod = "cron_update";
  assert.equal(browserMethod, "cron_update");
  assert.equal(typeof GatewayBrowserClient.prototype.cronUpdate, "function");
});
