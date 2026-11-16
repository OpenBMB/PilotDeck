import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCronManager, defaultCronConfig } from '../../src/cron/index.js';
import { CronReminderStore, taskReminder } from '../../src/cron/storage/CronReminderStore.js';
import type { Gateway, GatewaySubmitTurnInput } from '../../src/gateway/index.js';

test('due reminders survive busy conversations, duplicate ticks, acknowledgement and runtime restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-reminders-'));
  const project = join(home, 'project'); await mkdir(project);
  let now = new Date('2026-06-01T08:00:00Z');
  let submissions = 0;
  const gateway = { getActiveTurnSnapshot: async () => ({ active: true }), closeSession: async () => {},
    async *submitTurn() { submissions++; } } as unknown as Gateway;
  const create = () => {
    const manager = createCronManager({ config: defaultCronConfig(), pilotHome: home, now: () => now });
    manager.bindGateway(gateway); return manager;
  };
  let manager = create();
  try {
    await manager.start();
    const { task } = await manager.createTask({ name: 'Meeting', message: 'Attend the meeting', reminderTiming: 'due',
      projectKey: project, schedule: { type: 'once', runAt: '2026-06-01T09:00:00Z' }, timezone: 'UTC' });
    now = new Date('2026-06-01T09:00:00Z');
    await manager.runTickOnce(); await manager.runTickOnce();
    const first = (await manager.listReminders({ scope: '1' })).reminders;
    assert.equal(first.length, 1); assert.equal(first[0].taskId, task.taskId); assert.equal(first[0].kind, 'due');
    assert.equal(submissions, 0, 'arrival notification must not wait for model admission');
    assert.equal((await manager.listTasks()).tasks[0].nextRunAt, task.nextRunAt);
    // Reading/listing is never acknowledgement.
    assert.equal((await manager.listReminders({ scope: '1' })).reminders.length, 1);
    assert.deepEqual(await manager.dismissReminder({ scope: '1', id: first[0].id }), { dismissed: true });
    assert.equal((await manager.listReminders({ scope: '1' })).reminders.length, 0);
    assert.equal((await manager.listReminders({ scope: '2' })).reminders.length, 1);
    await manager.stop(); manager = create(); await manager.start(); await manager.runTickOnce();
    assert.equal((await manager.listReminders({ scope: '1' })).reminders.length, 0);
    assert.deepEqual((await manager.listReminders({ scope: '2' })).reminders.map(item => item.id), [first[0].id]);
  } finally { await manager.stop(); await rm(home, { recursive: true, force: true }); }
});

test('result notifications honor findings/failure policy and retain independent periodic occurrences', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-reminder-results-'));
  const project = join(home, 'project'); await mkdir(project);
  const manager = createCronManager({ config: { ...defaultCronConfig(), maxConcurrentRuns: 4 }, pilotHome: home,
    now: () => new Date('2026-06-01T08:00:00Z') });
  manager.bindGateway({ closeSession: async () => {}, abortTurn: async () => {}, async *submitTurn(input: GatewaySubmitTurnInput) {
    if (input.message.includes('failure')) throw new Error('Synthetic execution failure');
    yield { type: 'assistant_text_delta', text: input.message.includes('quiet') ? '[NO_UPDATE]' : 'Report complete' };
  } } as unknown as Gateway);
  try {
    await manager.start();
    for (const [name, policy] of [['report', 'all'], ['quiet', 'findings'], ['success', 'failures'], ['failure', 'failures'], ['due-failure', 'failures']] as const) {
      const { task } = await manager.createTask({ name, message: name, projectKey: project,
        notificationPolicy: policy, reminderTiming: name === 'due-failure' ? 'due' : 'result', schedule: { type: 'cron', expression: '0 9 * * *' }, timezone: 'UTC' });
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
