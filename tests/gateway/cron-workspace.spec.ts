import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createCronManager, defaultCronConfig } from '../../src/cron/index.js';
import { SessionConfigOverrides } from '../../src/always-on/runtime/SessionConfigOverrides.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from '../../src/model/index.js';
import { createProjectId } from '../../src/pilot/paths.js';
import type { GatewayEvent } from '../../src/gateway/index.js';

async function fixture(t: test.TestContext, git: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'pilotdeck-task-workspace-'));
  const home = join(root, 'state'), project = join(root, 'project'), skills = join(root, 'skills');
  await Promise.all([mkdir(home), mkdir(project), mkdir(skills)]);
  if (git) {
    const run = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
    run('init'); run('config', 'user.name', 'Scheduler QA'); run('config', 'user.email', 'scheduler@example.invalid');
    await writeFile(join(project, 'fixture.txt'), 'Committed input'); run('add', '.'); run('commit', '-m', 'Fixture');
  }
  const record = join(home, 'projects', createProjectId(project)); await mkdir(record, { recursive: true });
  await writeFile(join(record, '.cwd'), project);
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
  const sessionOverrides = new SessionConfigOverrides(), events: GatewayEvent[] = [], cwds: string[] = [], requests: CanonicalModelRequest[] = [];
  const cron = createCronManager({ config: defaultCronConfig(), pilotHome: home, sessionOverrides, onTurnEvent: (_session, _channel, event) => { events.push(event); } });
  let calls = 0;
  const local = createLocalGateway({ pilotHome: home, projectRoot: project, builtinSkillsRoot: skills,
    env: { PILOT_HOME: home, PILOTDECK_CONFIG_PATH: configPath }, cron, sessionOverrides,
    extraTools: [{ name: 'observe_workspace', title: 'Observe workspace', kind: 'filesystem', description: 'Synthetic workspace observer',
      inputSchema: { type: 'object', properties: {} }, isReadOnly: () => true, isConcurrencySafe: () => true,
      execute: async (_input, context) => { cwds.push(context.cwd); return { content: [{ type: 'text', text: context.cwd }] }; } }],
    __testModelFactory(snapshot) { return { ...createModelRuntime(snapshot.config.model),
      async *stream(request): AsyncIterable<CanonicalModelEvent> {
        requests.push(request); yield { type: 'message_start', role: 'assistant' };
        if (++calls % 2) {
          const toolCall = { id: `observer-${calls}`, name: 'observe_workspace', input: {} };
          yield { type: 'tool_call_start', id: toolCall.id, name: toolCall.name };
          yield { type: 'tool_call_end', toolCall }; yield { type: 'message_end', finishReason: 'tool_call' };
        } else { yield { type: 'text_delta', text: 'TASK_CONTEXT_TOKEN' }; yield { type: 'message_end', finishReason: 'stop' }; }
      },
    }; },
  });
  cron.bindGateway(local.gateway);
  t.after(async () => { await cron.stop(); local.dispose(); await rm(root, { recursive: true, force: true }); });
  const task = (await cron.createTask({ name: 'Workspace report', message: 'Inspect workspace', projectKey: project,
    workspaceMode: git ? 'local' : 'worktree', notificationPolicy: 'findings',
    schedule: { type: 'cron', expression: '0 18 * * 5' }, timezone: 'UTC' })).task;
  const run = async () => {
    const execution = await cron.runTaskNow({ taskId: task.taskId });
    assert.equal(execution.started, true);
    const deadline = Date.now() + 10_000;
    while (!events.some(event => event.type === 'agent_status' && event.event === 'cron_settled' && event.runId === execution.runId)) {
      if (Date.now() > deadline) throw new Error('Task did not settle');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return (await cron.listTasks({ taskId: task.taskId })).tasks[0];
  };
  return { cron, gateway: local.gateway, project, task, run, events, cwds, requests };
}

test('task workspace changes rebuild the execution session while retaining conversation context and plain input', async t => {
  const f = await fixture(t, true);
  let task = await f.run();
  for (const workspaceMode of ['worktree', 'local'] as const) {
    assert.equal((await f.cron.updateTask({ taskId: task.taskId, projectKey: f.project, expectedRevision: task.revision!,
      message: task.message, schedule: task.schedule, timezone: task.timezone, workspaceMode })).updated, true);
    task = await f.run();
    assert.equal(f.cwds.at(-1), task.lastRun?.workspaceCwd);
    assert.equal(f.cwds.at(-1) === f.project, workspaceMode === 'local');
  }
  assert.equal(f.cwds.length, 3);
  assert.ok(JSON.stringify(f.requests.at(-1)?.messages).includes('TASK_CONTEXT_TOKEN'));
  const history = await f.gateway.readSessionMessages({ sessionKey: task.sessionKey, projectKey: f.project });
  const inputs = history.messages.filter(message => message.kind === 'text' && message.role === 'user');
  assert.equal(inputs.length, 3);
  assert.ok(inputs.every(message => message.text === task.message));
  assert.ok(JSON.stringify(f.requests[0].messages).includes('[NO_UPDATE]'));
  assert.equal(await readFile(join(f.project, 'fixture.txt'), 'utf8'), 'Committed input');
});

test('workspace preparation errors are visible live and survive repeated task history reads', async t => {
  const f = await fixture(t, false);
  const task = await f.run();
  assert.equal(task.lastRun?.outcome, 'failed');
  assert.equal(f.requests.length, 0);
  assert.ok(f.events.some(event => event.type === 'error' && event.message.includes('not a git repository')));
  for (let i = 0; i < 2; i++) {
    const history = await f.gateway.readSessionMessages({ sessionKey: task.sessionKey, projectKey: f.project });
    assert.equal(history.messages.filter(message => message.kind === 'error' && message.text?.includes('not a git repository')).length, 1);
  }
});
