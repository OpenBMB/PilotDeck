import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCronManager, defaultCronConfig, resolveCronPaths } from '../../src/cron/index.js';
import { createProjectId } from '../../src/pilot/paths.js';
import { createDefaultPermissionContext } from '../../src/permission/index.js';
import type { Gateway } from '../../src/gateway/index.js';
import type { PilotDeckToolRuntimeContext } from '../../src/tool/index.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pilotdeck-cron-project-validation-'));
  const home = join(root, 'state'), project = join(root, 'workspace');
  await mkdir(home); await mkdir(project);
  const record = join(home, 'projects', createProjectId(project));
  const register = async () => { await mkdir(record, { recursive: true }); await writeFile(join(record, '.cwd'), project); };
  const manager = createCronManager({ config: defaultCronConfig(), pilotHome: home });
  manager.bindGateway({ closeSession: async () => {}, async *submitTurn() { throw new Error('Creation must not execute a turn'); } } as unknown as Gateway);
  await manager.start();
  t.after(async () => { await manager.stop(); await rm(root, { recursive: true, force: true }); });
  const input = { name: 'Meeting', message: 'Attend the meeting', projectKey: project,
    schedule: { type: 'once' as const, runAt: '2030-01-01T09:00:00Z' } };
  const context = (projectKey = project): PilotDeckToolRuntimeContext => ({
    cwd: project, projectKey, sessionId: 'web:validation', turnId: 'turn-1', permissionMode: 'default',
    permissionContext: createDefaultPermissionContext({ cwd: project, mode: 'default', canPrompt: false, bypassAvailable: false }),
    env: { PILOT_HOME: home },
  });
  return { root, home, project, record, register, manager, input, context };
}

for (const scenario of ['unregistered', 'missing', 'file'] as const) {
  test(`creation rejects an ${scenario} project without writing a Cron task or marker`, async t => {
    const f = await fixture(t);
    if (scenario !== 'unregistered') {
      await f.register();
      await rm(f.project, { recursive: true });
      if (scenario === 'file') await writeFile(f.project, 'Not a directory');
    }
    await assert.rejects(f.manager.createTask(f.input), { code: 'cron_project_unavailable' });
    assert.deepEqual((await f.manager.listTasks()).tasks, []);
    const paths = resolveCronPaths({ pilotHome: f.home, projectKey: f.project });
    await assert.rejects(readdir(paths.projectDir), { code: 'ENOENT' });
  });
}

test('creation revalidates a removed registration without changing existing tasks', async t => {
  const f = await fixture(t);
  await f.register();
  const { task } = await f.manager.createTask(f.input);
  await rm(f.record, { recursive: true });
  await assert.rejects(f.manager.createTask(f.input), { code: 'cron_project_unavailable' });
  assert.deepEqual((await f.manager.listTasks()).tasks.map(item => item.taskId), [task.taskId]);
});

test('Agent creation uses the same project validation and accepts a registered workspace', async t => {
  const f = await fixture(t);
  const create = f.manager.getTools().find(tool => tool.name === 'cron_create')!;
  const context = f.context();
  await assert.rejects(create.execute(f.input, context), { code: 'cron_project_unavailable' });
  await f.register();
  await create.execute(f.input, context);
  assert.equal((await f.manager.listTasks()).tasks.length, 1);
});

test('General creation retains its virtual identity and separate unregistered execution directory', async t => {
  const f = await fixture(t);
  const direct = await f.manager.createTask({ ...f.input, projectKey: 'general', workspaceCwd: f.project });
  assert.equal(direct.task.projectKey, f.home);
  const create = f.manager.getTools().find(tool => tool.name === 'cron_create')!;
  await create.execute({ ...f.input, projectKey: 'general' }, f.context(f.home));
  assert.equal((await f.manager.listTasks()).tasks.length, 2);
});
