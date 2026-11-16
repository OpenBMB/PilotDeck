import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createCronManager, defaultCronConfig } from '../../src/cron/index.js';
import { SessionConfigOverrides } from '../../src/always-on/runtime/SessionConfigOverrides.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from '../../src/model/index.js';
import { createProjectId } from '../../src/pilot/paths.js';

test('task chat and scheduled execution share history and trusted workspace, with per-turn interaction capabilities', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-task-dialog-'));
  const project = join(home, 'project'), skills = join(home, 'skills');
  await mkdir(project); await mkdir(skills);
  const projectRecord = join(home, 'projects', createProjectId(project));
  await mkdir(projectRecord, { recursive: true });
  await writeFile(join(projectRecord, '.cwd'), project);
  const configPath = join(home, 'pilotdeck.yaml');
  await writeFile(configPath, `schemaVersion: 1
agent: { model: test/model }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: synthetic
      models: { model: {} }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
runtime: { python: { enabled: false } }
memory: { enabled: false }
telemetry: { enabled: false }
`);
  const sessionOverrides = new SessionConfigOverrides();
  const cron = createCronManager({ config: defaultCronConfig(), pilotHome: home, sessionOverrides });
  const requests: CanonicalModelRequest[] = [];
  const local = createLocalGateway({ pilotHome: home, projectRoot: project, builtinSkillsRoot: skills,
    env: { PILOT_HOME: home, PILOTDECK_CONFIG_PATH: configPath }, cron, sessionOverrides, extraTools: cron.getTools(),
    __testModelFactory(snapshot) { return { ...createModelRuntime(snapshot.config.model),
      async *stream(request): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        yield { type: 'message_start', role: 'assistant' };
        yield { type: 'text_delta', text: 'Synthetic task reply' };
        yield { type: 'message_end', finishReason: 'stop' };
      },
      async complete() { return { role: 'assistant' as const, content: [{ type: 'text' as const, text: '{"title":"Task"}' }], finishReason: 'stop' as const }; },
    }; },
  });
  cron.bindGateway(local.gateway);
  try {
    const task = (await cron.createTask({ name: 'Task dialog', message: 'Produce a concise report', projectKey: project,
      schedule: { type: 'cron', expression: '0 18 * * 5' }, timezone: 'UTC' })).task;
    const events = [];
    for await (const event of local.gateway.submitTurn({ sessionKey: task.sessionKey, projectKey: project,
      channelKey: 'web', message: 'Remember CONTEXT_TOKEN for later reports.', workspaceCwd: '/untrusted-directory' })) events.push(event);
    assert.ok(events.some(event => event.type === 'turn_completed'), JSON.stringify(events));
    assert.equal((await cron.listTasks({ taskId: task.taskId, includeHistory: true })).recentRuns?.length, 0);
    assert.equal((await cron.listTasks({ taskId: task.taskId })).tasks[0].nextRunAt, task.nextRunAt);
    assert.ok(requests[0].tools?.some(tool => tool.name === 'ask_user_question'));
    assert.ok(JSON.stringify(requests[0].messages).includes(task.taskId));
    assert.ok(JSON.stringify(requests[0].messages).includes('Produce a concise report'));
    assert.ok(!JSON.stringify(requests[0]).includes('/untrusted-directory'));
    const run = await cron.runTaskNow({ taskId: task.taskId });
    assert.equal(run.started, true);
    for (let i = 0; i < 200; i++) {
      const current = (await cron.listTasks({ taskId: task.taskId })).tasks[0];
      if (current.lastRun?.finishedAt) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok((await cron.listTasks({ taskId: task.taskId })).tasks[0].lastRun?.finishedAt);
    assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[1].messages).includes('Remember CONTEXT_TOKEN'));
    assert.ok(!requests[1].tools?.some(tool => tool.name === 'ask_user_question'));
    const denied = [];
    for await (const event of local.gateway.submitTurn({ sessionKey: task.sessionKey, projectKey: join(home, 'other'),
      channelKey: 'web', message: 'Invalid owner' })) denied.push(event);
    assert.ok(denied.some(event => event.type === 'error'));
    assert.equal(requests.length, 2);
  } finally { await cron.stop(); local.dispose(); await rm(home, { recursive: true, force: true }); }
});
