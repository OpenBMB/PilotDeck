import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";
import type { CronCreateInput, CronResultDeliveryHandler, CronTask } from "../../src/cron/protocol/types.js";
import { createCronRuntime, defaultCronConfig, CronTaskStore, resolveCronPaths, type CreateCronRuntimeOptions } from "../../src/cron/index.js";
import { computeNextRunAt, computeNextCronRunAt, previewCronSchedule } from "../../src/cron/runtime/CronSchedule.js";
import { CronScheduler } from "../../src/cron/runtime/CronScheduler.js";
import type { CronFire } from "../../src/cron/runtime/CronFire.js";
import { createCronManager } from "../../src/cron/runtime/CronManager.js";
import { generateCronTaskDetails } from "../../src/cron/runtime/CronTaskDetails.js";
import { migrateCronStores } from "../../src/cron/storage/CronStoreMigration.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

async function fixture(options: {
  submit?: (input: GatewaySubmitTurnInput) => AsyncIterable<GatewayEvent>;
  delivery?: CronResultDeliveryHandler;
  max?: number;
  details?: CreateCronRuntimeOptions["generateTaskDetails"];
} = {}) {
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
    projectKey: project, store, now: () => now, onResultDelivery: options.delivery, generateTaskDetails: options.details });
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
    assert.ok(f.inputs.every(input => input.canPrompt === true));
    const runs = await f.store.listRuns(10, task.taskId);
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.trigger === "manual" && run.message === task.message && run.output === "Synthetic report"));
    assert.equal(f.closed.includes(f.inputs[0].sessionKey), false);
  } finally { await f.close(); }
});

test("a persisted calendar task runs at each exact time and advances to the next selected weekday", async () => {
  const f = await fixture();
  try {
    const { task } = await f.create({ schedule: { type: "calendar", times: ["15:40", "10:15"],
      weekdays: [3, 1], timezone: "Asia/Shanghai" } });
    const first = "2026-06-03T02:15:00.000Z";
    const second = "2026-06-03T07:40:00.000Z";
    assert.equal(task.nextRunAt, first);
    assert.deepEqual((await f.store.getTask(task.taskId))?.schedule,
      { type: "calendar", times: ["10:15", "15:40"], weekdays: [1, 3], timezone: "Asia/Shanghai" });
    f.setNow(first);
    await f.runtime.runTickOnce(); await f.idle();
    assert.equal((await f.store.getTask(task.taskId))?.nextRunAt, second);
    f.setNow("2026-06-03T02:40:00.000Z");
    await f.runtime.runTickOnce(); await f.idle();
    assert.equal(f.inputs.length, 1);
    f.setNow(second);
    await f.runtime.runTickOnce(); await f.idle();
    assert.equal((await f.store.getTask(task.taskId))?.nextRunAt, "2026-06-08T02:15:00.000Z");
    assert.deepEqual(f.inputs.map(input => input.sessionKey), [task.sessionKey, task.sessionKey]);
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

test("an unexpected interaction in a Full Access run produces a visible blocked result", async () => {
  const f = await fixture({ submit: async function* () {
    yield { type: "permission_request", requestId: "permission-1", toolName: "web_search", payload: {} };
  } });
  const abortReasons: string[] = [];
  const statusCodes: unknown[] = [];
  f.gateway.abortTurn = async ({ reason }) => { abortReasons.push(reason!); };
  f.gateway.recordAgentStatusMessage = async ({ status }) => {
    statusCodes.push(status.detail?.code);
    return { recorded: true };
  };
  try {
    const { task } = await f.create({ mode: "bypassPermissions" });
    f.setNow(task.nextRunAt!);
    await f.runtime.runTickOnce();
    await f.idle();
    const result = await f.store.getTask(task.taskId);
    assert.equal(result?.status, "failed");
    assert.equal(result?.enabled, false);
    assert.equal(result?.lastRun?.outcome, "blocked");
    assert.equal(result?.lastRun?.error?.toolName, "web_search");
    assert.deepEqual(statusCodes, ["cron_permission_required"]);
    assert.deepEqual(abortReasons, ["system:interaction_required"]);
  } finally { await f.close(); }
});

test("legacy read-only tasks migrate to default permissions and Full Access is preserved", async () => {
  const f = await fixture();
  try {
    const { task: oldDefault } = await f.create();
    const { task: oldReadOnly } = await f.create();
    const { task: fullAccess } = await f.create({ mode: "bypassPermissions" });
    const { tasksFile } = resolveCronPaths({ pilotHome: f.home, projectKey: f.project });
    await writeFile(tasksFile, JSON.stringify({ schemaVersion: 1,
      tasks: [oldDefault, { ...oldReadOnly, mode: "plan" }, fullAccess] }));
    await migrateCronStores({ pilotHome: f.home });
    await migrateCronStores({ pilotHome: f.home });
    const saved = JSON.parse(await readFile(tasksFile, "utf8")).tasks as CronTask[];
    const modes = new Map(saved.map(task => [task.taskId, task.mode]));
    assert.equal(modes.get(oldDefault.taskId), "default");
    assert.equal(modes.get(oldReadOnly.taskId), "default");
    assert.equal(modes.get(fullAccess.taskId), "bypassPermissions");
    await f.runtime.runTaskNow({ taskId: oldReadOnly.taskId }); await f.idle();
    await f.runtime.runTaskNow({ taskId: fullAccess.taskId }); await f.idle();
    assert.deepEqual(f.inputs.map(({ mode, canPrompt }) => [mode, canPrompt]), [["default", true], ["bypassPermissions", false]]);
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
  const checked: string[] = [];
  f.gateway.getActiveTurnSnapshot = async ({ sessionKey }) => { checked.push(sessionKey); return { sessionKey, active: sessionKey === "web:source", events: [] }; };
  try {
    const { task } = await f.create({ executionMode: "conversation", sessionKey: "web:source", channelKey: "web", mode: "bypassPermissions" });
    assert.equal(task.executionMode, "persistent"); assert.equal(task.targetSessionKey, undefined);
    assert.equal(task.originSessionKey, "web:source"); assert.match(task.sessionKey, /^cron:/);
    await f.runtime.runTaskNow({ taskId: task.taskId }); await f.idle();
    assert.ok(checked.length > 0 && checked.every(key => key === task.sessionKey)); assert.equal(f.inputs[0].sessionKey, task.sessionKey);
    assert.equal(f.inputs[0].channelKey, "cron"); assert.equal(f.inputs[0].mode, "bypassPermissions");
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

for (const [label, schedule, dueAt] of [
  ["monthly ordinal weekday", { type: "monthly", ordinal: 1, weekday: 1, hour: 9, minute: 0, timezone: "UTC" }, "2026-06-01T09:00:00.000Z"],
  ["partial-minute interval", { type: "interval", everySeconds: 90, anchorAt: "2026-06-01T08:00:00.000Z" }, "2026-06-01T08:01:30.000Z"],
] as const) {
  test(`an existing ${label} can still be edited and run`, async () => {
    const f = await fixture();
    try {
      const { task } = await f.create({ schedule });
      const update = f.runtime.getTools().find(tool => tool.name === "cron_update")!;
      const message = "Run the updated report";
      await update.execute({ taskId: task.taskId, expectedRevision: task.revision, message, schedule: task.schedule },
        { cwd: f.project, projectKey: f.project, sessionId: "web:fixture" } as PilotDeckToolRuntimeContext);
      const saved = await f.store.getTask(task.taskId);
      assert.equal(saved?.message, message);
      assert.deepEqual(saved?.schedule, task.schedule);
      assert.equal(saved?.nextRunAt, dueAt);
      f.setNow(dueAt);
      await f.runtime.runTickOnce();
      await f.idle();
      assert.equal(f.inputs[0]?.message, message);
      const executed = await f.store.getTask(task.taskId);
      assert.equal(executed?.lastRun?.outcome, "completed");
      assert.deepEqual(executed?.schedule, task.schedule);
    } finally { await f.close(); }
  });
}

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


test("model naming is asynchronous metadata and never delays execution or invalidates an open edit", async () => {
  let resolveTitle!: (title: string | null) => void;
  let titleInput: CronTask | undefined;
  const f = await fixture({ details: async task => {
    titleInput = task;
    const title = await new Promise<string | null>(resolve => { resolveTitle = resolve; });
    return title ? { title } : null;
  } });
  try {
    const { task } = await f.create({ name: undefined, message: "Produce a short daily project summary" });
    assert.equal(titleInput?.message, task.message);
    assert.equal(task.revision, 0);
    await f.runtime.runTaskNow({ taskId: task.taskId }); await f.idle();
    const before = (await f.store.getTask(task.taskId))!;
    const changed = new Promise<void>(resolve => { const unsubscribe = f.store.subscribe(change => {
      if (change.task?.name === 'Daily project summary') { unsubscribe(); resolve(); }
    }); });
    resolveTitle('Daily project summary'); await changed;
    const named = (await f.store.getTask(task.taskId))!;
    assert.equal(named.name, 'Daily project summary'); assert.equal(named.revision, before.revision);
    assert.equal(named.lastRun?.output, 'Synthetic report');
    const edited = await f.runtime.updateTask({ taskId: task.taskId, projectKey: f.project, expectedRevision: before.revision!,
      message: named.message, schedule: named.schedule, enabled: false });
    assert.equal(edited.updated, true);
  } finally { await f.close(); }
});

test("stale model names cannot overwrite newer instructions or recreate deleted tasks", async () => {
  const requests: { signal: AbortSignal; resolve: (details: { title: string }) => void }[] = [];
  const f = await fixture({ details: (_task, signal) => new Promise(resolve => { requests.push({ signal, resolve }); }) });
  try {
    const { task } = await f.create({ name: undefined, message: "Old instruction" });
    const edit = await f.runtime.updateTask({ taskId: task.taskId, projectKey: f.project, expectedRevision: task.revision!,
      message: 'New instruction', schedule: task.schedule });
    assert.equal(edit.updated, true); assert.equal(requests.length, 2); assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ title: 'Stale old title' }); await new Promise(resolve => setImmediate(resolve));
    assert.notEqual((await f.store.getTask(task.taskId))?.name, 'Stale old title');
    await f.runtime.deleteTask({ taskId: task.taskId });
    assert.equal(requests[1].signal.aborted, true);
    requests[1].resolve({ title: 'Late title' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(await f.store.getTask(task.taskId), undefined);
    await f.create({ name: 'Agent-supplied title' });
    assert.equal(requests.length, 2);
  } finally { await f.close(); }
});

test("Web task instructions are prepared once before saving and used by an immediate run", async () => {
  let complete!: (response: string) => void;
  const pending = new Promise<string>(resolve => { complete = resolve; });
  const requests: string[] = [];
  const original = "提醒我喝水";
  const instructions = "提醒用户喝水。";
  const f = await fixture({ details: (task, signal, mode) => generateCronTaskDetails({
    text: task.message, taskId: task.taskId, sessionId: task.sessionKey, signal, mode,
    model: { provider: "fixture", model: "model" },
    modelRuntime: {
      async complete(request) {
        const [block] = request.messages[0].content;
        assert.equal(block.type, "text");
        if (block.type === "text") requests.push(block.text);
        return { role: "assistant", content: [{ type: "text", text: await pending }], finishReason: "stop" };
      },
    },
  }) });
  try {
    const creating = f.create({ name: undefined, message: original, generateInstructions: true });
    assert.deepEqual(requests, [original]);
    assert.deepEqual((await f.runtime.listTasks()).tasks, []);

    complete('<think>Prepare the reminder.</think>\n```JSON\n' +
      JSON.stringify({ title: "喝水提醒", instructions, schedule: { type: "delay", amount: 5 } }) + '\n```');
    const { task } = await creating;
    assert.equal(task.name, "喝水提醒");
    assert.equal((await f.store.getTask(task.taskId))?.message, instructions);
    assert.equal(task.nextRunAt, "2026-06-01T09:00:00.000Z");
    assert.equal((await f.runtime.runTaskNow({ taskId: task.taskId })).started, true);
    await f.idle();
    assert.equal(f.inputs[0].message, instructions);
    assert.deepEqual(requests, [original]);
  } finally { complete(""); await f.close(); }
});

test("Web creation saves the original input when the model fails or returns unusable instructions", async () => {
  const replies = ["not JSON", JSON.stringify({ title: "Unusable title", instructions: " " })];
  const failures: string[] = [];
  let calls = 0;
  const f = await fixture({ details: (task, signal, mode) => generateCronTaskDetails({
    text: task.message, taskId: task.taskId, sessionId: task.sessionKey, signal, mode,
    onFallback: reason => failures.push(reason),
    model: { provider: "fixture", model: "model" },
    modelRuntime: {
      async complete() {
        const reply = replies[calls++];
        if (reply === undefined) throw new Error("Fixture provider error");
        return { role: "assistant", content: [{ type: "text", text: reply }], finishReason: "stop" };
      },
    },
  }) });
  try {
    for (const message of ["Remind me to stretch", "Remind me to take a break", "Remind me to hydrate"]) {
      const { task } = await f.create({ name: undefined, message, generateInstructions: true });
      assert.equal(task.name, message);
      assert.equal((await f.store.getTask(task.taskId))?.message, message);
    }
    assert.equal(calls, 3);
    assert.deepEqual(failures, ["invalid_response", "invalid_response", "provider_error"]);
  } finally { await f.close(); }
});

test("Web creation keeps valid generated instructions when the model omits the title", async () => {
  const message = "Remind me to drink water";
  const instructions = "Tell the user it is time to drink water using a single sentence.";
  const f = await fixture({ details: (task, signal, mode) => generateCronTaskDetails({
    text: task.message, taskId: task.taskId, sessionId: task.sessionKey, signal, mode,
    model: { provider: "fixture", model: "model" },
    modelRuntime: { async complete() {
      return { role: "assistant", content: [{ type: "text", text: JSON.stringify({ instructions }) }], finishReason: "stop" };
    } },
  }) });
  try {
    const { task } = await f.create({ name: undefined, message, generateInstructions: true });
    assert.equal(task.name, message);
    assert.equal(task.message, instructions);
  } finally { await f.close(); }
});

test("Web instruction generation falls back to the original input after its one-minute deadline", async t => {
  const deadline = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  let modelSignal: AbortSignal | undefined;
  const failures: string[] = [];
  const f = await fixture({ details: (task, signal, mode) => generateCronTaskDetails({
    text: task.message, taskId: task.taskId, sessionId: task.sessionKey, signal, mode,
    onFallback: reason => failures.push(reason),
    model: { provider: "fixture", model: "model" },
    modelRuntime: { complete(_request, options) {
      modelSignal = options?.signal;
      return new Promise(() => {});
    } },
  }) });
  try {
    const message = "提醒我起来走走";
    const creating = f.create({ name: undefined, message, generateInstructions: true });
    assert.deepEqual(timeout.mock.calls.map(call => call.arguments), [[60_000]]);
    deadline.abort(new DOMException("Fixture deadline", "TimeoutError"));
    const { task } = await creating;
    assert.equal(modelSignal?.aborted, true);
    assert.deepEqual(failures, ["deadline_exceeded"]);
    assert.equal((await f.store.getTask(task.taskId))?.message, message);
  } finally { await f.close(); }
});

test("a one-time schedule that expires while generating instructions is rejected by the save", async () => {
  const f = await fixture({ details: async () => {
    f.setNow("2026-06-01T08:00:02Z");
    return { title: "Break reminder", instructions: "Tell the user to take a break now." };
  } });
  try {
    await assert.rejects(f.create({ message: "Reminder", generateInstructions: true,
      schedule: { type: "once", runAt: "2026-06-01T08:00:01.000Z" },
    }), /scheduled in the future/);
    assert.deepEqual((await f.runtime.listTasks()).tasks, []);
  } finally { await f.close(); }
});

test('a busy conversation defers its occurrence without creating a failed run, including admission races', async () => {
  let active = true, raced = false;
  const f = await fixture({ submit: async function* () {
    if (raced) { yield { type: 'error', code: 'session_busy', message: 'Another turn won admission', recoverable: true }; return; }
    yield { type: 'assistant_text_delta', text: 'Accepted scheduled run' };
  } });
  f.gateway.getActiveTurnSnapshot = async input => ({ active, sessionKey: input.sessionKey, events: [] });
  try {
    const task = (await f.create()).task;
    f.setNow('2026-06-01T09:00:00Z');
    await f.runtime.runTickOnce(); await f.idle();
    assert.equal((await f.runtime.runTaskNow({ taskId: task.taskId })).reason, 'already_running');
    assert.equal(f.inputs.length, 0);
    assert.equal((await f.store.listRuns(10)).length, 0);
    assert.equal((await f.store.getTask(task.taskId))?.nextRunAt, task.nextRunAt);
    active = false; raced = true;
    await f.runtime.runTickOnce(); await f.idle();
    assert.equal((await f.store.getTask(task.taskId))?.status, 'scheduled');
    assert.equal((await f.store.getTask(task.taskId))?.nextRunAt, task.nextRunAt);
    assert.equal((await f.store.listRuns(10)).length, 0);
    raced = false;
    await f.runtime.runTickOnce(); await f.idle();
    assert.equal((await f.store.listRuns(10)).length, 1);
    assert.equal((await f.store.getTask(task.taskId))?.nextRunAt, '2026-06-02T09:00:00.000Z');
  } finally { await f.close(); }
});

test('lasting instruction updates during execution preserve its snapshot and feed the following occurrence', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ submit: async function* () { yield { type: 'assistant_text_delta', text: 'Working' }; await gate; } });
  try {
    const original = (await f.create()).task;
    await f.runtime.runTaskNow({ taskId: original.taskId });
    const running = (await f.store.getTask(original.taskId))!;
    const result = await f.runtime.updateTask({ taskId: running.taskId, projectKey: f.project,
      expectedRevision: running.revision!, schedule: running.schedule, timezone: running.timezone,
      message: 'Generate a report. Always verify primary sources.' });
    assert.equal(result.updated, true);
    const reschedule = await f.runtime.updateTask({ taskId: running.taskId, projectKey: f.project,
      expectedRevision: result.updated ? result.task.revision! : 0, message: 'Changed', schedule: { type: 'cron', expression: '0 10 * * *', timezone: 'UTC' } });
    assert.deepEqual(reschedule, { updated: false, reason: 'running' });
    release(); await f.idle();
    assert.equal((await f.store.listRuns(1))[0].message, original.message);
    assert.equal((await f.store.getTask(original.taskId))?.nextRunAt, original.nextRunAt);
    f.setNow('2026-06-01T09:00:00Z');
    await f.runtime.runTickOnce(); await f.idle();
    assert.equal(f.inputs.at(-1)?.message, 'Generate a report. Always verify primary sources.');
  } finally { release(); await f.close(); }
});

test('Agent instruction updates preserve an omitted task name instead of regenerating it', async () => {
  let titles = 0;
  const f = await fixture({ details: async () => { titles++; return { title: 'Unexpected replacement title' }; } });
  try {
    const { task } = await f.create();
    const tool = f.runtime.getTools().find(tool => tool.name === 'cron_update')!;
    await tool.execute({ taskId: task.taskId, expectedRevision: task.revision, message: 'Report using primary sources.' },
      { cwd: f.project, projectKey: f.project, sessionId: task.sessionKey } as PilotDeckToolRuntimeContext);
    const saved = (await f.store.getTask(task.taskId))!;
    assert.equal(saved.message, 'Report using primary sources.');
    assert.equal(saved.name, task.name);
    assert.equal(saved.nextRunAt, task.nextRunAt);
    assert.equal(titles, 0);
  } finally { await f.close(); }
});
