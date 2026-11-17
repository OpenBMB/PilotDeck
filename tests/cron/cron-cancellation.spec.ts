import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Gateway, GatewayEvent } from '../../src/gateway/index.js';
import type { CronTask } from '../../src/cron/protocol/types.js';
import { CronFire, type CronActiveRun } from '../../src/cron/runtime/CronFire.js';
import { CronTaskStore } from '../../src/cron/storage/CronTaskStore.js';
import { resolveCronPaths } from '../../src/cron/storage/CronPaths.js';
import { createCronRuntime, defaultCronConfig } from '../../src/cron/index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('the public stop API prevents submission after a real first worktree checkout', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pilotdeck-cron-stop-worktree-'));
  const home = join(root, 'state'), project = join(root, 'source');
  await mkdir(project);
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Task QA'); git('config', 'user.email', 'task@example.invalid');
  await writeFile(join(project, 'fixture.txt'), 'Committed source');
  git('add', '.'); git('commit', '-m', 'Synthetic fixture');
  const paths = resolveCronPaths({ pilotHome: home, projectKey: project });
  const store = new CronTaskStore(paths), entered = deferred(), release = deferred(), settled = deferred();
  let submitted = 0;
  const aborts: unknown[] = [];
  const gateway = { closeSession: async () => {}, abortTurn: async (input: unknown) => { aborts.push(input); },
    async *submitTurn() { submitted++; yield { type: 'assistant_text_delta', text: 'Should never run' }; },
  } as unknown as Gateway;
  const runtime = createCronRuntime({ config: defaultCronConfig(), pilotHome: home, projectKey: project, store,
    onTurnEvent: (_session, _channel, event) => { if (event.type === 'agent_status' && event.event === 'cron_settled') settled.resolve(); },
  });
  runtime.bindGateway(gateway);
  t.after(async () => { release.resolve(); await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  const task = (await runtime.createTask({ name: 'Report', message: 'Generate a report', workspaceMode: 'worktree',
    schedule: { type: 'interval', everySeconds: 3600 } })).task;
  const worktree = join(paths.rootDir, 'worktrees', task.taskId);
  const update = store.updateTask.bind(store);
  t.mock.method(store, 'updateTask', async (...args: Parameters<typeof update>) => {
    const saved = await update(...args);
    if (saved?.status === 'running' && saved.lastRun?.workspaceCwd === worktree) {
      entered.resolve(); await release.promise;
    }
    return saved;
  });
  const started = await runtime.runTaskNow({ taskId: task.taskId });
  assert.equal(started.started, true);
  await entered.promise;
  assert.equal(await realpath(worktree), await realpath(execFileSync('git', ['-C', worktree, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()));
  const stopped = await runtime.stopTask({ taskId: task.taskId, runId: started.runId });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.runId, started.runId);
  assert.ok(aborts.some(input => (input as { runId?: string }).runId === started.runId));
  release.resolve();
  await settled.promise;
  assert.equal(submitted, 0);
  assert.equal((await store.listRuns(1, task.taskId))[0].outcome, 'stopped');
});

for (const trigger of ['manual', 'scheduled'] as const) {
  for (const boundary of ['preparation', 'workspace persistence'] as const) {
    test(`a stop during ${boundary} prevents ${trigger} execution from reaching Gateway`, { timeout: 10_000 }, async t => {
      const root = await mkdtemp(join(tmpdir(), 'pilotdeck-cron-cancellation-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const home = join(root, 'state'), project = join(root, 'source'), workspace = join(root, 'task-worktree');
      await mkdir(project);
      const store = new CronTaskStore(resolveCronPaths({ pilotHome: home, projectKey: project }));
      const task: CronTask = { schemaVersion: 1, taskId: 'task-1', projectKey: project, workspaceMode: 'worktree',
        sessionKey: 'cron:task-1', channelKey: 'cron', message: 'Prepare the report',
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, timezone: 'UTC',
        status: 'scheduled', enabled: true, revision: 0, createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z', nextRunAt: '2026-01-01T00:00:00.000Z' };
      await store.putTask(task);
      const entered = deferred(), release = deferred();
      const activeRuns = new Map<string, CronActiveRun>();
      const events: GatewayEvent[] = [];
      let submitted = 0, cleaned = 0, reminders = 0;
      const gateway = { async *submitTurn() { submitted++; yield { type: 'assistant_text_delta', text: 'Should never run' }; } } as unknown as Gateway;
      if (boundary === 'workspace persistence') {
        const update = store.updateTask.bind(store);
        t.mock.method(store, 'updateTask', async (...args: Parameters<typeof update>) => {
          const saved = await update(...args);
          if (saved?.status === 'running' && saved.lastRun?.workspaceCwd === workspace) {
            entered.resolve(); await release.promise;
          }
          return saved;
        });
      }
      const fire = new CronFire({ gateway, store, now: () => new Date('2026-01-01T00:00:00.000Z'),
        registerActiveRun: run => { activeRuns.set(run.runId, run); },
        getActiveRun: id => activeRuns.get(id), unregisterActiveRun: id => {
          const run = activeRuns.get(id); activeRuns.delete(id); return run;
        }, runTimeoutMs: 60_000, defaultTimezone: 'UTC', releaseTaskSession: async () => {},
        prepareRun: async () => {
          if (boundary === 'preparation') { entered.resolve(); await release.promise; }
          return workspace;
        }, releaseRun: async () => { cleaned++; }, onReminder: async () => { reminders++; },
        onTurnEvent: (_session, _channel, event) => { events.push(event); },
      });
      const execution = fire.runTask(task, 'run-1', { trigger });
      try {
        await entered.promise;
        assert.equal((await store.getTask(task.taskId))?.status, 'running');
        assert.equal(submitted, 0);
        // CronRuntime.stopTask and shutdown set this same registered run flag.
        activeRuns.get('run-1')!.stopRequested = true;
      } finally { release.resolve(); }
      await execution;
      assert.equal(submitted, 0, 'A cancelled preparation must not start a model/tool turn');
      const runs = await store.listRuns(10, task.taskId);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].outcome, 'stopped');
      assert.equal(runs[0].output, '');
      assert.equal(runs[0].error, undefined);
      assert.equal(runs[0].workspaceCwd, workspace);
      const saved = (await store.getTask(task.taskId))!;
      assert.equal(saved.status, 'scheduled');
      assert.equal(saved.enabled, true);
      assert.equal(saved.nextRunAt, trigger === 'manual' ? task.nextRunAt : '2026-01-01T01:00:00.000Z');
      assert.equal(activeRuns.size, 0);
      assert.equal(cleaned, 1);
      assert.equal(reminders, 0);
      assert.ok(events.some(event => event.type === 'agent_status' && event.event === 'cron_settled' && event.detail?.finishReason === 'aborted'));
    });
  }
}
