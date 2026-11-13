import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";
import type { CronCreateInput, CronResultDeliveryHandler, CronTask } from "../../src/cron/protocol/types.js";
import { createCronRuntime, defaultCronConfig, CronTaskStore, resolveCronPaths } from "../../src/cron/index.js";
import { computeNextRunAt, computeNextCronRunAt, previewCronSchedule } from "../../src/cron/runtime/CronSchedule.js";
import { CronScheduler } from "../../src/cron/runtime/CronScheduler.js";
import type { CronFire } from "../../src/cron/runtime/CronFire.js";
import { createCronManager } from "../../src/cron/runtime/CronManager.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

async function fixture(options: { submit?: (input: GatewaySubmitTurnInput) => AsyncIterable<GatewayEvent>; delivery?: CronResultDeliveryHandler; max?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-cron-lifecycle-"));
  const home = join(root, "state");
  const project = join(root, "workspace");
  await mkdir(home); await mkdir(project);
  const store = new CronTaskStore(resolveCronPaths({ pilotHome: home, projectKey: project }));
  const inputs: GatewaySubmitTurnInput[] = [];
  const closed: string[] = [];
  let now = new Date("2026-06-01T08:00:00Z");
  const gateway = {
    async *submitTurn(input: GatewaySubmitTurnInput) {
      inputs.push(input);
      if (options.submit) yield* options.submit(input);
      else yield { type: "assistant_text_delta", text: "Synthetic report" } as GatewayEvent;
    },
    closeSession: async ({ sessionKey }: { sessionKey: string }) => { closed.push(sessionKey); },
    abortTurn: async () => undefined,
  } as unknown as Gateway;
  const runtime = createCronRuntime({ config: { ...defaultCronConfig(), maxConcurrentRuns: options.max ?? 1 }, pilotHome: home,
    projectKey: project, store, now: () => now, onResultDelivery: options.delivery });
  runtime.bindGateway(gateway);
  const create = (input: Partial<CronCreateInput> = {}) => runtime.createTask({ name: "Daily report", message: "Generate a report",
    schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" }, projectKey: project, ...input });
  const idle = async () => {
    const deadline = Date.now() + 4_000;
    while (runtime.getActiveRunCount() > 0) {
      if (Date.now() > deadline) throw new Error("Run did not settle.");
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  };
  return { home, project, runtime, store, gateway, inputs, closed, create, idle, setNow: (value: string) => { now = new Date(value); },
    close: async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("manual runs keep the original task, schedule and prompt snapshot, using one task conversation", async () => {
  const f = await fixture();
  try {
    const { task } = await f.create();
    const first = await f.runtime.runTaskNow({ taskId: task.taskId });
    assert.equal(first.started, true);
    assert.equal(first.taskId, task.taskId);
    await f.idle();
    await f.runtime.runTaskNow({ taskId: task.taskId });
    await f.idle();
    assert.equal((await f.store.listTasks()).length, 1);
    assert.equal((await f.store.getTask(task.taskId))?.nextRunAt, task.nextRunAt);
    assert.equal(f.inputs[0].sessionKey, f.inputs[1].sessionKey);
    assert.equal(f.inputs[0].sessionKey, task.sessionKey);
    assert.deepEqual(f.inputs.map(input => input.mode), ["default", "default"]);
    assert.ok(f.inputs.every(input => input.canPrompt === false));
    const runs = await f.store.listRuns(10, task.taskId);
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.trigger === "manual" && run.message === task.message && run.output === "Synthetic report"));
    assert.equal(f.closed.includes(f.inputs[0].sessionKey), false);
  } finally { await f.close(); }
});

test("paused tasks do not fire, manual runs preserve pause, and resume selects a future occurrence", async () => {
  const f = await fixture();
  try {
    let task = (await f.create()).task;
    let result = await f.runtime.updateTask({ taskId: task.taskId, projectKey: f.project, expectedRevision: task.revision!, message: task.message, schedule: task.schedule, enabled: false });
    assert.equal(result.updated, true);
    f.setNow("2026-06-01T10:00:00Z");
    await f.runtime.runTickOnce();
    assert.equal(f.inputs.length, 0);
    await f.runtime.runTaskNow({ taskId: task.taskId });
    await f.idle();
    task = (await f.store.getTask(task.taskId))!;
    assert.equal(task.status, "paused");
    assert.equal(task.nextRunAt, "2026-06-01T09:00:00.000Z");
    result = await f.runtime.updateTask({ taskId: task.taskId, projectKey: f.project, expectedRevision: task.revision!, message: task.message, schedule: task.schedule, enabled: true });
    assert.ok(result.updated);
    assert.equal(result.task.nextRunAt, "2026-06-02T09:00:00.000Z");
  } finally { await f.close(); }
});

test("a failed one-time execution remains available with its error and can be retried", async () => {
  let failed = true;
  const f = await fixture({ submit: async function* () {
    if (failed) yield { type: "error", code: "model_unavailable", message: "Synthetic provider is offline", recoverable: false };
    else yield { type: "assistant_text_delta", text: "Recovered" };
  } });
  try {
    const { task } = await f.create({ schedule: { type: "delay", amount: 1, unit: "second" } });
    f.setNow("2026-06-01T08:00:02Z");
    await f.runtime.runTickOnce();
    await f.idle();
    assert.equal((await f.store.getTask(task.taskId))?.status, "failed");
    assert.equal((await f.store.listRuns(1, task.taskId))[0].error?.code, "model_unavailable");
    failed = false;
    assert.equal((await f.runtime.runTaskNow({ taskId: task.taskId })).started, true);
    await f.idle();
    assert.equal((await f.store.getTask(task.taskId))?.status, "completed");
    assert.equal((await f.store.listRuns(5, task.taskId)).length, 2);
  } finally { await f.close(); }
});

test("execution admission prevents duplicate manual runs and obeys the shared limit", async () => {
  let release!: () => void;
  const done = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ submit: async function* () { await done; yield { type: "assistant_text_delta", text: "Done" }; } });
  try {
    const first = (await f.create()).task;
    const second = (await f.create({ name: "Other report" })).task;
    const started = await f.runtime.runTaskNow({ taskId: first.taskId });
    assert.equal(started.started, true);
    assert.equal((await f.runtime.runTaskNow({ taskId: first.taskId })).reason, "already_running");
    assert.equal((await f.runtime.runTaskNow({ taskId: second.taskId })).reason, "concurrency_limit");
    const current = (await f.store.getTask(first.taskId))!;
    const paused = await f.runtime.updateTask({ taskId: first.taskId, projectKey: f.project, expectedRevision: current.revision!, message: current.message, schedule: current.schedule, enabled: false });
    assert.ok(paused.updated);
    release();
    await f.idle();
    assert.equal((await f.store.getTask(first.taskId))?.status, "paused");
  } finally { release(); await f.close(); }
});

test("task results never call the source-chat delivery handler, including legacy retry requests", async () => {
  let deliveries = 0;
  const f = await fixture({ delivery: async () => { deliveries++; return true; } });
  try {
    const task = (await f.create({ sessionKey: "web:origin", channelKey: "web" })).task;
    await f.runtime.runTaskNow({ taskId: task.taskId }); await f.idle();
    const run = (await f.store.listRuns(1, task.taskId))[0];
    assert.equal(run.outcome, "completed"); assert.equal(run.output, "Synthetic report");
    assert.equal(run.deliveryStatus, "skipped"); assert.equal(deliveries, 0);
    await f.runtime.runTaskNow({ taskId: task.taskId, retryDeliveryRunId: run.runId });
    assert.equal(f.inputs.length, 1); assert.equal(deliveries, 0);
  } finally { await f.close(); }
});

test("permission interactions stop unattended work with a visible blocked result", async () => {
  const f = await fixture({ submit: async function* () {
    yield { type: "permission_request", requestId: "permission-1" } as GatewayEvent;
  } });
  try {
    const { task } = await f.create();
    await f.runtime.runTaskNow({ taskId: task.taskId });
    await f.idle();
    const result = await f.store.getTask(task.taskId);
    assert.equal(result?.status, "failed");
    assert.equal(result?.enabled, false);
    assert.equal(result?.lastRun?.outcome, "blocked");
  } finally { await f.close(); }
});

test("damaged task stores reject reads and writes without replacing the original bytes", async () => {
  const f = await fixture();
  try {
    await f.create();
    const file = resolveCronPaths({ pilotHome: f.home, projectKey: f.project }).tasksFile;
    const broken = '{"schemaVersion":1,"tasks":[BROKEN';
    await writeFile(file, broken);
    await assert.rejects(f.store.listTasks(), /damaged.*preserved/);
    await assert.rejects(f.create(), /damaged.*preserved/);
    assert.equal(await readFile(file, "utf8"), broken);
    await writeFile(file, '{"schemaVersion":1,"tasks":[]}');
  } finally { await f.close(); }
});

test("intervals preserve their anchor and monthly weekday rules are evaluated in their timezone", () => {
  assert.equal(computeNextRunAt({ type: "interval", everySeconds: 3600, anchorAt: "2026-06-01T08:00:00Z" }, new Date("2026-06-01T11:23:00Z"))?.toISOString(), "2026-06-01T12:00:00.000Z");
  const schedule = { type: "monthly" as const, ordinal: 1 as const, weekday: 1, hour: 9, minute: 0, timezone: "Asia/Shanghai" };
  assert.equal(computeNextRunAt(schedule, new Date("2026-06-01T00:00:00Z"))?.toISOString(), "2026-06-01T01:00:00.000Z");
  assert.equal(computeNextRunAt({ ...schedule, ordinal: -1 }, new Date("2026-06-01T00:00:00Z"))?.toISOString(), "2026-06-29T01:00:00.000Z");
  assert.equal(previewCronSchedule({ type: "interval", everySeconds: 60 }, new Date("2026-06-01T00:00:00Z")).length, 3);
  for (const expression of ["1abc * * * *", "*/2oops * * * *", "0 9 1-2-3 * *", "1/2 * * * *"]) assert.equal(computeNextCronRunAt(expression, new Date()), undefined);
});

test("scheduler waits for the nearest occurrence and never rewrites an overdue time when busy", async (t) => {
  const f = await fixture();
  let delay: number | undefined;
  t.mock.method(globalThis, "setTimeout", (_callback: () => void, ms: number) => { delay = ms; return { unref() {} }; });
  try {
    const { task } = await f.create({ schedule: { type: "delay", amount: 5, unit: "second" } });
    const scheduler = new CronScheduler({ config: defaultCronConfig(), store: f.store, fire: {} as CronFire,
      uuid: () => "run", now: () => new Date("2026-06-01T08:00:00Z"), activeRunCount: () => 1 });
    await scheduler.start();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(delay, 5_000);
    f.setNow("2026-06-01T08:01:00Z");
    await f.runtime.runTickOnce();
    assert.equal((await f.store.getTask(task.taskId))?.nextRunAt, task.nextRunAt);
    await scheduler.stop();
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("description-only edits preserve the committed occurrence and stale edits conflict", async () => {
  const f = await fixture();
  try {
    const { task } = await f.create();
    f.setNow("2026-06-01T10:00:00Z");
    const update = { taskId: task.taskId, projectKey: f.project, expectedRevision: task.revision!, message: "Revised report format", schedule: task.schedule, name: "Renamed report" };
    const result = await f.runtime.updateTask(update);
    assert.ok(result.updated);
    assert.equal(result.task.nextRunAt, task.nextRunAt);
    assert.deepEqual(await f.runtime.updateTask(update), { updated: false, reason: "conflict" });
  } finally { await f.close(); }
});

test("legacy conversation inputs create an owned task session without touching the active source chat", async () => {
  const f = await fixture();
  let checked = false;
  f.gateway.getActiveTurnSnapshot = async ({ sessionKey }) => { checked = true; return { sessionKey, active: true, events: [] }; };
  try {
    const { task } = await f.create({ executionMode: "conversation", sessionKey: "web:source", channelKey: "web", mode: "plan" });
    assert.equal(task.executionMode, "persistent"); assert.equal(task.targetSessionKey, undefined);
    assert.equal(task.originSessionKey, "web:source"); assert.match(task.sessionKey, /^cron:/);
    await f.runtime.runTaskNow({ taskId: task.taskId }); await f.idle();
    assert.equal(checked, false); assert.equal(f.inputs[0].sessionKey, task.sessionKey);
    assert.equal(f.inputs[0].channelKey, "cron"); assert.equal(f.inputs[0].mode, "plan");
    assert.equal(f.closed.includes("web:source"), false);
  } finally { await f.close(); }
});

test("offline one-time tasks are marked missed, and a new future date reactivates them", async () => {
  const f = await fixture();
  try {
    const { task } = await f.create({ schedule: { type: "delay", amount: 1, unit: "minute" } });
    f.setNow("2026-06-02T08:00:00Z");
    await f.runtime.start();
    const missed = (await f.store.getTask(task.taskId))!;
    assert.equal(missed.status, "missed");
    assert.equal(f.inputs.length, 0);
    const result = await f.runtime.updateTask({ taskId: task.taskId, projectKey: f.project, expectedRevision: missed.revision!, message: task.message,
      schedule: { type: "once", runAt: "2026-06-03T08:00:00Z" } });
    assert.ok(result.updated);
    assert.equal(result.task.status, "scheduled");
    assert.equal(result.task.enabled, true);
  } finally { await f.close(); }
});

test("restart recovers a committed one-time result instead of losing or repeating the task", async () => {
  const f = await fixture();
  try {
    const { task } = await f.create({ schedule: { type: "delay", amount: 60, unit: "second" } });
    await f.store.putTask({ ...task, status: "running", lastRunId: "committed-run" });
    await f.store.appendRun({ schemaVersion: 1, taskId: task.taskId, runId: "committed-run", sessionKey: "cron:committed", startedAt: "2026-06-01T08:00:00Z", finishedAt: "2026-06-01T08:00:01Z", outcome: "completed", output: "Saved output", deliveryStatus: "skipped" });
    await f.runtime.start();
    const recovered = await f.store.getTask(task.taskId);
    assert.equal(recovered?.status, "completed");
    assert.equal(recovered?.lastRun?.output, "Saved output");
    assert.equal(f.inputs.length, 0);
  } finally { await f.close(); }
});

test("Agent tools preserve General identity and execution directory, and manage tasks created by other entry points", async () => {
  const f = await fixture();
  const manager = createCronManager({ config: defaultCronConfig(), pilotHome: f.home, now: () => new Date("2026-06-01T08:00:00Z") });
  manager.bindGateway(f.gateway);
  try {
    await manager.start();
    const tools = manager.getTools();
    for (const name of ["cron_create", "cron_get", "cron_update", "cron_list", "cron_run_now", "cron_stop", "cron_delete"]) assert.ok(tools.some(tool => tool.name === name));
    const context = { cwd: f.project, projectKey: f.home, sessionId: "web:general", now: () => new Date("2026-06-01T08:00:00Z") } as PilotDeckToolRuntimeContext;
    const created = await tools.find(tool => tool.name === "cron_create")!.execute({ name: "General report", message: "Synthetic task", schedule: { type: "delay", amount: 60, unit: "minute" }, timezone: "UTC" }, context);
    const task = (created.data as { task: CronTask }).task;
    assert.equal(task.projectKey, f.home);
    assert.equal(task.workspaceCwd, await realpath(f.project));
    const updated = await tools.find(tool => tool.name === "cron_update")!.execute({ taskId: task.taskId, expectedRevision: task.revision, enabled: false }, context);
    assert.equal((updated.data as { task: CronTask }).task.status, "paused");
    const detail = await tools.find(tool => tool.name === "cron_get")!.execute({ taskId: task.taskId }, context);
    assert.equal((detail.data as { task: CronTask }).task.name, "General report");
    const pageTask = (await manager.createTask({ projectKey: f.home, workspaceCwd: f.project,
      message: "Calendar report", schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" } })).task;
    const moved = await tools.find(tool => tool.name === "cron_update")!.execute({ taskId: pageTask.taskId,
      expectedRevision: pageTask.revision, timezone: "Asia/Shanghai" }, context);
    const movedTask = (moved.data as { task: CronTask }).task;
    assert.equal(movedTask.timezone, "Asia/Shanghai");
    assert.equal(movedTask.nextRunAt, "2026-06-02T01:00:00.000Z");
  } finally { await manager.stop(); await f.close(); }
});

test("durable task changes publish ordered revisions for creation, execution, pause and deletion", async () => {
  const f = await fixture();
  const events: Array<{ taskId: string; status?: string; revision?: number; output?: string }> = [];
  const unsubscribe = f.store.subscribe(({ taskId, task }) => events.push({ taskId, status: task?.status, revision: task?.revision, output: task?.lastRun?.output }));
  try {
    const { task } = await f.create();
    await f.runtime.runTaskNow({ taskId: task.taskId }); await f.idle();
    const current = (await f.store.getTask(task.taskId))!;
    await f.runtime.updateTask({ taskId: task.taskId, projectKey: f.project, expectedRevision: current.revision!, message: current.message, schedule: current.schedule, enabled: false });
    await f.runtime.deleteTask({ taskId: task.taskId });
    assert.deepEqual(events.map(event => event.status), ['scheduled', 'running', 'scheduled', 'paused', undefined]);
    assert.deepEqual(events.slice(0, 4).map(event => event.revision), [0, 1, 2, 3]);
    assert.equal(events[2].output, 'Synthetic report');
    assert.ok(events.every(event => event.taskId === task.taskId));
  } finally { unsubscribe(); await f.close(); }
});

test("startup migrates legacy task modes without adopting or closing ordinary conversations", async () => {
  const f = await fixture();
  try {
    const { task } = await f.create();
    await f.store.putTask({ ...task, executionMode: 'conversation', sessionKey: 'web:user-history', targetSessionKey: 'web:user-history' });
    await f.runtime.start();
    const migrated = (await f.store.getTask(task.taskId))!;
    assert.equal(migrated.executionMode, 'persistent'); assert.match(migrated.sessionKey, /^cron:/);
    assert.equal(migrated.targetSessionKey, undefined); assert.equal(f.closed.includes('web:user-history'), false);
    await f.runtime.runTaskNow({ taskId: task.taskId }); await f.idle();
    assert.equal(f.inputs[0].sessionKey, migrated.sessionKey);
  } finally { await f.close(); }
});
