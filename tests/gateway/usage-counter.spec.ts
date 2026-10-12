import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime } from '../../src/model/index.js';

test('gateway records OpenAI stream usage but excludes a successful title call with routing disabled', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-usage-'));
  await mkdir(join(home, 'skills'));
  await writeFile(join(home, 'pilotdeck.yaml'), `
schemaVersion: 1
agent: { model: test/model, maxContextTokens: 65536, maxOutputTokens: 8192 }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: fixture
      models: { model: {} }
router: { enabled: false }
memory: { enabled: false }
telemetry: { enabled: false }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false, computer-use: false }
`);
  let streams = 0;
  let titles = 0;
  const local = createLocalGateway({
    pilotHome: home, projectRoot: home, builtinSkillsRoot: join(home, 'skills'),
    env: { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: join(home, 'pilotdeck.yaml'), PILOT_AGENT_MODEL: undefined },
    __testModelFactory(snapshot) {
      return createModelRuntime(snapshot.config.model, {
        async fetch(_url, init) {
          const body = JSON.parse(String(init?.body));
          if (body.stream) {
            streams++;
            // Like the official protocol, only return usage when requested.
            const chunks = [
              { choices: [{ delta: { role: 'assistant', content: 'hello' }, finish_reason: null }], usage: null },
              { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
              ...(body.stream_options?.include_usage ? [{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }] : []),
            ];
            return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
              headers: { 'content-type': 'text/event-stream' },
            });
          }
          assert.equal(body.metadata?.purpose, 'session_title_generation');
          assert.equal(body.stream_options, undefined);
          titles++;
          return new Response(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '{"title":"Usage test"}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }), { headers: { 'content-type': 'application/json' } });
        },
      });
    },
  });
  t.after(async () => { local.dispose(); await rm(home, { recursive: true, force: true }); });
  const catalog = await local.gateway.modelCatalogList!({ includeAuto: true });
  assert.equal(catalog.router.autoAvailable, false);
  const events = [];
  for await (const event of local.gateway.submitTurn({ projectKey: home, sessionKey: 'web:usage', channelKey: 'web', message: 'hello' })) events.push(event);
  assert.ok(events.some(event => event.type === 'turn_completed'));
  assert.equal(events.some(event => event.type === 'error'), false);
  let records: number[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const dir = join(home, 'usage/daily');
      const files = await readdir(dir);
      records = (await Promise.all(files.map(file => readFile(join(dir, file), 'utf8')))).join('').trim().split('\n').map(Number);
    }
    catch { /* asynchronous counter may not have flushed yet */ }
    if (records.length === 1 && titles === 1) break;
    await setTimeout(10);
  }
  assert.equal(streams, 1);
  assert.equal(titles, 1);
  assert.deepEqual(records, [120]);
});
