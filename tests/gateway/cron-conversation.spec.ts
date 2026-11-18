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
import type { GatewayEvent } from '../../src/gateway/index.js';
import { writePermissionSettings } from '../../src/permission/settings.js';

const SYNTHETIC_CONFIG = `schemaVersion: 1
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
`;

async function syntheticProject(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-task-dialog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'project'), skills = join(home, 'skills');
  await mkdir(project); await mkdir(skills);
  const projectRecord = join(home, 'projects', createProjectId(project));
  await mkdir(projectRecord, { recursive: true });
  const configPath = join(home, 'pilotdeck.yaml');
  await writeFile(join(projectRecord, '.cwd'), project);
  await writeFile(configPath, SYNTHETIC_CONFIG);
  return { home, project, skills, env: { PILOT_HOME: home, PILOTDECK_CONFIG_PATH: configPath } };
}

test('task chat and scheduled execution share history and trusted workspace, with per-turn interaction capabilities', async (t) => {
  const { home, project, skills, env } = await syntheticProject(t);
  const sessionOverrides = new SessionConfigOverrides();
  const cron = createCronManager({ config: defaultCronConfig(), pilotHome: home, sessionOverrides });
  const requests: CanonicalModelRequest[] = [];
  const local = createLocalGateway({ pilotHome: home, projectRoot: project, builtinSkillsRoot: skills,
    env, cron, sessionOverrides, extraTools: cron.getTools(),
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
    assert.ok(JSON.stringify(requests[0].messages).includes('A successful cron_update saves task instructions, not project memory.'));
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
    assert.ok(requests[1].tools?.some(tool => tool.name === 'ask_user_question'));
    const denied = [];
    for await (const event of local.gateway.submitTurn({ sessionKey: task.sessionKey, projectKey: join(home, 'other'),
      channelKey: 'web', message: 'Invalid owner' })) denied.push(event);
    assert.ok(denied.some(event => event.type === 'error'));
    assert.equal(requests.length, 2);
  } finally { await cron.stop(); local.dispose(); }
});

test('saved cron permissions control approval, completion reminders, and interruption', async (t) => {
  const { home, project, skills, env } = await syntheticProject(t);
  const previousHome = process.env.PILOT_HOME;
  process.env.PILOT_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = previousHome;
  });
  const events: GatewayEvent[] = [];
  let now = new Date();
  let modelStep = 0;
  let executed = 0;
  let useSubagent = true;
  const cron = createCronManager({
    config: defaultCronConfig(), pilotHome: home, now: () => now,
    onTurnEvent(_sessionKey, _channelKey, event) { events.push(event); },
  });
  const local = createLocalGateway({ pilotHome: home, projectRoot: project, builtinSkillsRoot: skills, env, cron,
    extraTools: [{
      name: 'synthetic_approval', kind: 'custom', description: 'Return a synthetic result after approval.',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => false, isConcurrencySafe: () => true,
      async execute() { executed++; return { content: [{ type: 'text', text: 'Approved synthetic result' }] }; },
    }],
    __testModelFactory(snapshot) { return { ...createModelRuntime(snapshot.config.model),
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        const step = modelStep++;
        yield { type: 'message_start', role: 'assistant' };
        if (step < (useSubagent ? 2 : 1)) {
          const delegate = useSubagent && step === 0;
          const input = delegate ? { description: 'Get synthetic result', prompt: 'Call synthetic_approval for the requested result.' } : {};
          const name = delegate ? 'agent' : 'synthetic_approval';
          const id = `call-${step}`;
          yield { type: 'tool_call_start', id, name };
          yield { type: 'tool_call_end', toolCall: { id, name, input } };
          yield { type: 'message_end', finishReason: 'tool_call' };
          return;
        }
        yield { type: 'text_delta', text: executed ? 'Synthetic result delivered' : 'Unable to complete without permission' };
        yield { type: 'message_end', finishReason: 'stop' };
      },
    }; },
  });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, JSON.stringify(events.map(event => event.type === 'agent_status' ? event.event : event.type)));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  cron.bindGateway(local.gateway);
  try {
    for (const [mode, trigger, resolution, subagent] of [
      ['default', 'scheduled', 'allow', true],
      ['default', 'manual', 'allow', true],
      ['bypassPermissions', 'scheduled', 'direct', true],
      ['bypassPermissions', 'manual', 'direct', true],
      ['default', 'manual', 'deny', false],
      ['default', 'scheduled', 'deny', true],
      ['bypassPermissions', 'manual', 'policy-deny', false],
      ['default', 'scheduled', 'stop', false],
    ] as const) {
      events.length = 0;
      modelStep = 0;
      executed = 0;
      useSubagent = subagent;
      const denied = resolution === 'deny' || resolution === 'policy-deny';
      writePermissionSettings({
        askTools: ['synthetic_approval'],
        disallowedTools: resolution === 'policy-deny' ? ['synthetic_approval'] : [],
      }, env);
      const runAt = new Date(now.getTime() + (trigger === 'scheduled' ? 60_000 : 86_400_000)).toISOString();
      const { task } = await cron.createTask({
        name: `Synthetic ${mode} ${trigger}`, message: 'Get the synthetic result', projectKey: project, mode,
        schedule: { type: 'once', runAt }, notificationPolicy: denied ? 'failures' : 'all',
      });
      if (trigger === 'scheduled') {
        now = new Date(runAt);
        await cron.runTickOnce(project);
      } else {
        assert.equal((await local.gateway.cronRunNow({ taskId: task.taskId })).started, true);
      }
      const settled = () => events.some(event => event.type === 'agent_status' && event.event === 'cron_settled');
      await until(() => settled() || events.some(event => event.type === 'permission_request'));
      const request = events.find(event => event.type === 'permission_request');
      if (mode === 'default') {
        assert.equal(request?.toolName, 'synthetic_approval');
        const waiting = (await cron.listTasks({ taskId: task.taskId })).tasks[0];
        assert.equal(waiting.status, 'running');
        assert.equal(waiting.lastRun?.finishedAt, undefined);
        assert.equal(executed, 0);
        const history = await local.gateway.readSessionMessages({ sessionKey: task.sessionKey, projectKey: project });
        assert.equal(history.stream?.runId, waiting.lastRun?.runId);
        assert.ok(history.stream?.events.some(event => event.type === 'permission_request' && event.requestId === request.requestId));
        assert.equal(modelStep, subagent ? 2 : 1);
        if (resolution === 'stop') {
          await local.gateway.abortTurn({ sessionKey: task.sessionKey, runId: waiting.lastRun?.runId });
        } else {
          assert.deepEqual(await local.gateway.permissionDecide({
            sessionKey: task.sessionKey, requestId: request.requestId, decision: resolution === 'deny' ? 'deny' : 'allow',
          }), { delivered: true });
        }
        await until(settled);
        assert.equal((await cron.listTasks({ taskId: task.taskId })).tasks[0].lastRun?.runId, waiting.lastRun?.runId);
      } else {
        assert.equal(request, undefined);
      }
      const { recentRuns } = await cron.listTasks({ taskId: task.taskId, includeHistory: true });
      assert.equal(recentRuns?.length, 1);
      assert.equal(recentRuns[0].trigger, trigger);
      assert.equal(recentRuns[0].outcome, resolution === 'stop' ? 'aborted' : denied ? 'failed' : 'completed');
      assert.equal(recentRuns[0].error?.code, denied ? 'cron_permission_denied' : undefined);
      assert.equal(executed, denied || resolution === 'stop' ? 0 : 1);
      const reminders = (await cron.listReminders({ scope: '1' })).reminders.filter(reminder => reminder.runId === recentRuns[0].runId);
      assert.deepEqual(reminders.map(reminder => reminder.kind), resolution === 'stop' ? [] : [denied ? 'failed' : 'completed']);
      if (denied) {
        assert.equal(recentRuns[0].error?.toolName, 'synthetic_approval');
        assert.match(reminders[0].body, /synthetic_approval/);
      } else if (resolution === 'stop') {
        const completion = events.find(event => event.type === 'turn_completed');
        assert.match(completion?.finishReason ?? '', /^aborted(?:_|$)/);
        assert.ok(!events.some(event => event.type === 'error' && event.code === 'agent_aborted'));
      } else {
        assert.equal(recentRuns[0].output, 'Synthetic result delivered');
      }
    }
  } finally { await cron.stop(); local.dispose(); }
});
