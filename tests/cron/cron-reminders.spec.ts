import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCronManager, defaultCronConfig, resolveCronPaths } from '../../src/cron/index.js';
import { CronReminderStore } from '../../src/cron/storage/CronReminderStore.js';
import type { Gateway, GatewaySubmitTurnInput } from '../../src/gateway/index.js';
import { createProjectId } from '../../src/pilot/paths.js';

async function registerProject(home: string, project: string) {
  const record = join(home, 'projects', createProjectId(project));
  await mkdir(record, { recursive: true });
  await writeFile(join(record, '.cwd'), project);
}

test('legacy due-mode tasks notify only after execution, with durable per-user acknowledgement', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-reminders-'));
  const project = join(home, 'project'); await mkdir(project);
  await registerProject(home, project);
  let now = new Date('2026-06-01T08:00:00Z');
  let busy = true;
  let submissions = 0;
  const runs = new EventEmitter();
  const finish = once(runs, 'finish');
  const gateway = { getActiveTurnSnapshot: async () => ({ active: busy }), closeSession: async () => {},
    async *submitTurn() {
      submissions++;
      yield { type: 'assistant_text_delta', text: 'Meeting reminder ready' };
      runs.emit('in-progress');
      await finish;
    } } as unknown as Gateway;
  const create = () => {
    const manager = createCronManager({ config: defaultCronConfig(), pilotHome: home, now: () => now,
      onTurnEvent: (_sessionKey, _channelKey, event) => {
        if (event.type === 'agent_status' && event.event === 'cron_settled') runs.emit('settled', event.runId);
      },
    });
    manager.bindGateway(gateway); return manager;
  };
  let manager = create();
  try {
    await manager.start();
    const { task } = await manager.createTask({ name: 'Meeting', message: 'Attend the meeting',
      projectKey: project, schedule: { type: 'once', runAt: '2026-06-01T09:00:00Z' }, timezone: 'UTC' });
    await manager.stop();
    const { tasksFile } = resolveCronPaths({ pilotHome: home, projectKey: project });
    const stored = JSON.parse(await readFile(tasksFile, 'utf8'));
    stored.tasks[0].reminderTiming = 'due';
    await writeFile(tasksFile, JSON.stringify(stored));
    manager = create(); await manager.start();

    now = new Date('2026-06-01T09:00:00Z');
    await manager.runTickOnce(); await manager.runTickOnce();
    assert.equal((await manager.listReminders({ scope: '1' })).reminders.length, 0);
    assert.equal(submissions, 0);
    assert.equal((await manager.listTasks()).tasks[0].nextRunAt, task.nextRunAt);

    busy = false;
    await Promise.all([
      once(runs, 'in-progress', { signal: AbortSignal.timeout(4000) }),
      manager.runTickOnce(),
    ]);
    assert.equal((await manager.listReminders({ scope: '1' })).reminders.length, 0);
    const settled = once(runs, 'settled', { signal: AbortSignal.timeout(4000) });
    runs.emit('finish');
    const [runId] = await settled;
    await manager.runTickOnce(); await manager.runTickOnce();
    const first = (await manager.listReminders({ scope: '1' })).reminders;
    assert.equal(submissions, 1);
    assert.equal(first.length, 1);
    assert.equal(first[0].taskId, task.taskId);
    assert.equal(first[0].kind, 'completed');
    assert.equal(first[0].runId, runId);
    // Reading/listing is never acknowledgement.
    assert.equal((await manager.listReminders({ scope: '1' })).reminders.length, 1);
    assert.deepEqual(await manager.dismissReminder({ scope: '1', id: first[0].id }), { dismissed: true });
    assert.equal((await manager.listReminders({ scope: '1' })).reminders.length, 0);
    assert.equal((await manager.listReminders({ scope: '2' })).reminders.length, 1);
    await manager.stop(); manager = create(); await manager.start(); await manager.runTickOnce();
    assert.equal((await manager.listReminders({ scope: '1' })).reminders.length, 0);
    assert.deepEqual((await manager.listReminders({ scope: '2' })).reminders.map(item => item.id), [first[0].id]);
  } finally { runs.emit('finish'); await manager.stop(); await rm(home, { recursive: true, force: true }); }
});

test('Run Now and the following scheduled execution produce separate result reminders', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-reminder-run-now-'));
  const project = join(home, 'project');
  const runs = new EventEmitter();
  let now = new Date('2026-06-01T08:00:00Z');
  const manager = createCronManager({
    config: defaultCronConfig(), pilotHome: home, now: () => now,
    onTurnEvent: (_sessionKey, _channelKey, event) => {
      if (event.type === 'agent_status' && event.event === 'cron_settled') runs.emit('settled', event.runId);
    },
  });
  manager.bindGateway({ closeSession: async () => {}, abortTurn: async () => {}, async *submitTurn() {
    yield { type: 'assistant_text_delta', text: 'Meeting reminder ready' };
  } } as unknown as Gateway);
  try {
    await mkdir(project);
    await registerProject(home, project);
    await manager.start();
    const runAt = '2026-06-01T09:00:00.000Z';
    const { task } = await manager.createTask({ name: 'Meeting', message: 'Attend the meeting',
      projectKey: project, schedule: { type: 'once', runAt }, timezone: 'UTC' });

    const [[manualRunId], manual] = await Promise.all([
      once(runs, 'settled', { signal: AbortSignal.timeout(4000) }),
      manager.runTaskNow({ taskId: task.taskId }),
    ]);
    assert.equal(manual.started, true);
    assert.equal(manual.runId, manualRunId);
    const { reminders: manualReminders } = await manager.listReminders({ scope: '1' });
    assert.equal(manualReminders.length, 1, 'Run Now must produce one result reminder');
    const [result] = manualReminders;
    assert.equal(result.kind, 'completed');
    assert.equal(result.runId, manualRunId);
    assert.equal(result.body, 'Meeting reminder ready');
    assert.equal((await manager.listTasks({ taskId: task.taskId })).tasks[0].nextRunAt, runAt);

    now = new Date(runAt);
    const [[scheduledRunId]] = await Promise.all([
      once(runs, 'settled', { signal: AbortSignal.timeout(4000) }),
      manager.runTickOnce(),
    ]);
    const { reminders } = await manager.listReminders({ scope: '1' });
    assert.deepEqual(reminders.map(reminder => reminder.kind), ['completed', 'completed']);
    assert.equal(reminders[0].taskId, task.taskId);
    assert.equal(reminders[0].occurrenceAt, runAt);
    assert.equal(reminders[0].runId, scheduledRunId);
    assert.notEqual(reminders[0].id, result.id);
  } finally { await manager.stop(); await rm(home, { recursive: true, force: true }); }
});

test('result notifications honor findings/failure policy and retain independent periodic occurrences', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-reminder-results-'));
  const project = join(home, 'project'); await mkdir(project);
  await registerProject(home, project);
  const manager = createCronManager({ config: { ...defaultCronConfig(), maxConcurrentRuns: 4 }, pilotHome: home,
    now: () => new Date('2026-06-01T08:00:00Z') });
  manager.bindGateway({ closeSession: async () => {}, abortTurn: async () => {}, async *submitTurn(input: GatewaySubmitTurnInput) {
    if (input.message.includes('failure')) throw new Error('Synthetic execution failure');
    yield { type: 'assistant_text_delta', text: input.message.includes('quiet') ? '[NO_UPDATE]' : 'Report complete' };
  } } as unknown as Gateway);
  try {
    await manager.start();
    for (const [name, policy] of [['report', 'all'], ['quiet', 'findings'], ['success', 'failures'], ['failure', 'failures'], ['all-failure', 'all']] as const) {
      const { task } = await manager.createTask({ name, message: name, projectKey: project,
        notificationPolicy: policy, schedule: { type: 'cron', expression: '0 9 * * *' }, timezone: 'UTC' });
      await manager.runTaskNow({ taskId: task.taskId });
      if (name === 'report') {
        for (let i = 0; i < 100 && (await manager.listTasks({ taskId: task.taskId })).tasks[0].status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
        let second = await manager.runTaskNow({ taskId: task.taskId });
        for (let i = 0; i < 100 && !second.started; i++) {
          await new Promise(resolve => setTimeout(resolve, 5));
          second = await manager.runTaskNow({ taskId: task.taskId });
        }
        assert.equal(second.started, true);
      }
    }
    for (let i = 0; i < 100 && (await manager.listTasks()).tasks.some(task => task.status === 'running'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 10));
    await manager.stop();
    const reminders = (await manager.listReminders({ scope: '1' })).reminders;
    assert.equal(reminders.length, 4);
    assert.equal(new Set(reminders.map(item => item.id)).size, 4);
    assert.equal(reminders.filter(item => item.title === 'report' && item.body === 'Report complete').length, 2);
    assert.equal(reminders.filter(item => item.kind === 'failed' && item.body === 'Synthetic execution failure').length, 2);
  } finally { await manager.stop(); await rm(home, { recursive: true, force: true }); }
});

test('reminder storage serializes duplicate creation and preserves malformed stores', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-reminder-store-'));
  const path = join(home, 'reminders.json'); const store = new CronReminderStore(path);
  try {
    const reminder = { id: 'a'.repeat(64), taskId: 'task', projectKey: '/project', sessionKey: 'cron:task', title: 'Meeting', body: 'Meeting now',
      kind: 'due' as const, createdAt: '2026-06-01T09:00:00Z', occurrenceAt: '2026-06-01T09:00:00Z' };
    const results = await Promise.all(Array.from({ length: 10 }, () => store.put(reminder)));
    assert.equal(results.filter(Boolean).length, 1);
    await store.dismiss('__proto__', reminder.id, reminder.createdAt);
    assert.equal((await store.list('__proto__')).length, 0);
    assert.equal((await store.list('1')).length, 1);
    const corrupt = '{"version":99,"reminders":[]}'; await writeFile(path, corrupt);
    await assert.rejects(store.put(reminder), /preserved/);
    assert.equal(await readFile(path, 'utf8'), corrupt);
  } finally { await rm(home, { recursive: true, force: true }); }
});
