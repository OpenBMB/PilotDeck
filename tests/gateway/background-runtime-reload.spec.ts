import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelEvent } from '../../src/model/index.js';
import type { GatewayEvent } from '../../src/gateway/protocol/types.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('a hot-reloaded turn retains its task runtime through empty lists and task completion', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-task-reload-'));
  const configPath = join(home, 'pilotdeck.yaml');
  await writeFile(configPath, `schemaVersion: 1
agent: { model: test/model }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: fixture-key
      models: { model: {} }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
telemetry: { enabled: false }
`);
  const entered = deferred(), firstTask = deferred(), createFirst = deferred(), createDetached = deferred();
  let round = 0;
  const local = createLocalGateway({ pilotHome: home, projectRoot: home, builtinSkillsRoot: join(home, 'skills'),
    permissionMode: 'bypassPermissions',
    env: { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: configPath, PILOT_AGENT_MODEL: undefined },
    __testModelFactory(snapshot) {
      return { ...createModelRuntime(snapshot.config.model),
        async *stream(): AsyncIterable<CanonicalModelEvent> {
          const step = round++;
          yield { type: 'message_start', role: 'assistant' };
          if (step < 2) {
            if (step === 0) { entered.resolve(); await createFirst.promise; }
            else { firstTask.resolve(); await createDetached.promise; }
            const call = { id: `task-${step}`, name: 'task_create', input: {
              command: step === 0 ? 'echo completed' : `"${process.execPath.replaceAll('\\', '/')}" -e "setTimeout(()=>{},60000)"`,
              lifecycle: 'service',
            } };
            yield { type: 'tool_call_start', id: call.id, name: call.name };
            yield { type: 'tool_call_end', toolCall: call };
            yield { type: 'message_end', finishReason: 'tool_call' };
          } else {
            yield { type: 'text_delta', text: 'Background task started.' };
            yield { type: 'message_end', finishReason: 'stop' };
          }
        },
        async complete() { return { role: 'assistant' as const, content: [{ type: 'text' as const, text: '{"title":"Task test"}' }], finishReason: 'stop' as const }; },
      };
    },
  });
  const tasks = local.registry.resolve(home).backgroundTasks;
  const events: GatewayEvent[] = [];
  const running = (async () => {
    for await (const event of local.gateway.submitTurn({ projectKey: home, sessionKey: 'web:reload-task', channelKey: 'web', message: 'start tasks' })) events.push(event);
  })();
  t.after(async () => {
    createFirst.resolve(); createDetached.resolve();
    await running.catch(() => {});
    for (const task of tasks.list({ status: ['pending', 'running'] })) await tasks.stop(task.taskId, { graceMs: 10 });
    local.dispose();
    assert.equal(dirname(home), resolve(tmpdir()));
    await rm(home, { recursive: true, force: true });
  });
  await entered.promise;
  local.registry.invalidate(home);
  for (let i = 0; i < 3; i++) assert.equal((await local.gateway.describeServer()).activeTaskCount, 1);
  createFirst.resolve();
  await firstTask.promise;
  const short = tasks.list()[0]!;
  assert.ok(short, 'the real task_create tool must execute on the retired runtime');
  await tasks.wait(short.taskId);
  assert.equal(tasks.list({ status: ['pending', 'running'] }).length, 0);
  for (let i = 0; i < 3; i++) assert.equal((await local.gateway.describeServer()).activeTaskCount, 1);
  createDetached.resolve();
  await running;
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
  assert.equal((await local.gateway.describeServer()).activeTurnCount, 0);
  assert.equal((await local.gateway.describeServer()).activeTaskCount, 1, 'detached task must retain quit confirmation after the turn');
  const detached = tasks.list({ status: ['pending', 'running'] })[0]!;
  await tasks.stop(detached.taskId, { graceMs: 10 });
  await tasks.wait(detached.taskId);
  assert.equal((await local.gateway.describeServer()).activeTaskCount, 0);
});
