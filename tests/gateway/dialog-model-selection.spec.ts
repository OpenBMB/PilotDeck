import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PilotConfigSnapshot } from '../../src/pilot/config/types.js';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from '../../src/model/index.js';
import { createAgentProjectSessionStorage, readTranscript, replayTranscriptEntries } from '../../src/session/index.js';
import type { GatewayEvent, GatewaySubmitTurnInput } from '../../src/gateway/protocol/types.js';

const A = { mode: 'model' as const, provider: 'alpha', model: 'first' };
const B = { mode: 'model' as const, provider: 'zeta', model: 'configured', reasoning: 0.8, temperature: 0.3, speed: 1 };
const CONFIG = `
schemaVersion: 1
agent:
  model: zeta/configured
  maxContextTokens: 65536
  maxOutputTokens: 8192
extension:
  builtinPluginsEnabled:
    windows-skills: false
    browser-use: false
    funasr: false
memory:
  enabled: false
telemetry:
  enabled: false
model:
  providers:
    alpha:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models:
        first: {}
    zeta:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      speedMapping: openai_service_tier
      models:
        configured:
          capabilities:
            supportsSpeed: true
router:
  enabled: true
  scenarios:
    default: zeta/configured
  fallback:
    default: [alpha/first]
  zeroUsageRetry:
    enabled: false
  transientRetry:
    enabled: false
`;

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-model-choice-'));
  await writeFile(join(home, 'pilotdeck.yaml'), CONFIG);
  await mkdir(join(home, 'skills'), { recursive: true });
  const requests: CanonicalModelRequest[] = [];
  let failZeta = false;
  const options = {
    pilotHome: home, projectRoot: home,
    env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
    builtinSkillsRoot: join(home, 'skills'),
    __testModelFactory: (snapshot: PilotConfigSnapshot) => ({
      ...createModelRuntime(snapshot.config.model),
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        yield { type: 'request_started', provider: request.provider, model: request.model };
        if (failZeta && request.provider === 'zeta') {
          yield { type: 'error', error: { provider: request.provider, protocol: 'openai', code: 'auth_error', message: 'test failure', retryable: false } };
          return;
        }
        yield { type: 'message_start', role: 'assistant' };
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } };
        yield { type: 'message_end', finishReason: 'stop' };
      },
      async complete() { return { role: 'assistant' as const, content: [{ type: 'text' as const, text: '' }], finishReason: 'stop' as const }; },
    }),
  };
  let local = createLocalGateway(options);
  t.after(async () => { local.dispose(); await rm(home, { recursive: true, force: true }); });
  return {
    home, requests,
    get gateway() { return local.gateway; },
    fail() { failZeta = true; },
    restart() { local.dispose(); local = createLocalGateway(options); },
    async submit(modelSelection?: GatewaySubmitTurnInput['modelSelection'], modelOverride?: GatewaySubmitTurnInput['modelOverride']) {
      const events: GatewayEvent[] = [];
      for await (const event of local.gateway.submitTurn({
        projectKey: home, sessionKey: 'web:model-choice', channelKey: 'web', message: 'hello', modelSelection, modelOverride,
      })) events.push(event);
      return events;
    },
    async saved() { return (await local.gateway.sessionModelGet!({ projectKey: home, sessionKey: 'web:model-choice' })).saved; },
  };
}

test('first-turn choice and parameters are durable at acceptance and survive gateway restart', async (t) => {
  const f = await fixture(t);
  const catalog = await f.gateway.modelCatalogList!({ projectKey: f.home, includeAuto: true });
  assert.equal(catalog.items[0]!.id, 'router/auto');
  assert.equal(catalog.items[1]!.id, 'alpha/first');
  assert.deepEqual(catalog.defaultSelection, { mode: 'model', provider: B.provider, model: B.model });
  for await (const event of f.gateway.submitTurn({ projectKey: f.home, sessionKey: 'web:model-choice', channelKey: 'web', message: 'hello', modelSelection: B })) {
    if (event.type === 'input_accepted') {
      assert.deepEqual(event.modelSelection, B);
      assert.deepEqual(await f.saved(), B);
    }
  }
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.provider, B.provider);
  assert.equal(f.requests[0]!.temperature, B.temperature);
  assert.equal(f.requests[0]!.speed, B.speed);
  assert.equal(f.requests[0]!.thinking?.mode, 'high');
  const storage = createAgentProjectSessionStorage({ projectRoot: f.home, pilotHome: f.home, sessionId: 'web:model-choice' });
  const entries = (await readTranscript(storage.transcriptPath)).entries;
  const acceptedOnly = entries.filter((e) => e.type === 'accepted_input');
  assert.deepEqual(replayTranscriptEntries(acceptedOnly).metadata.modelSelection, B, 'crash before metadata snapshot retains the choice');
  f.restart();
  assert.deepEqual(await f.saved(), B);
  await f.submit();
  assert.equal(f.requests.at(-1)!.provider, B.provider);
  assert.equal(f.requests.at(-1)!.speed, B.speed);
});

test('explicit Auto replaces saved concrete choice; one-turn overrides do not change saved preferences', async (t) => {
  const f = await fixture(t);
  await f.submit(A);
  assert.equal(f.requests.at(-1)!.provider, A.provider);
  await f.submit({ mode: 'auto' });
  assert.equal(f.requests.at(-1)!.provider, B.provider);
  assert.deepEqual(await f.saved(), { mode: 'auto' });
  f.restart();
  await f.submit();
  assert.equal(f.requests.at(-1)!.provider, B.provider);
  await f.submit(A);
  await f.submit(undefined, B);
  assert.equal(f.requests.at(-1)!.provider, B.provider);
  assert.deepEqual(await f.saved(), A);
  await f.submit();
  assert.equal(f.requests.at(-1)!.provider, A.provider);
});

test('concrete choices fail without silently falling back, while Auto retains fallback', async (t) => {
  const f = await fixture(t);
  f.fail();
  await f.submit(B);
  assert.ok(f.requests.length > 0);
  assert.deepEqual([...new Set(f.requests.map((r) => r.provider))], ['zeta']);
  f.requests.length = 0;
  f.restart();
  await f.submit({ mode: 'auto' });
  assert.deepEqual([...new Set(f.requests.map((r) => r.provider))], ['zeta', 'alpha']);
  assert.deepEqual(await f.saved(), { mode: 'auto' });
});

test('invalid and conflicting choices cannot execute or replace the saved preference', async (t) => {
  const f = await fixture(t);
  await f.submit(A);
  f.requests.length = 0;
  for (const input of [
    { modelSelection: { ...B, model: 'missing' } },
    { modelSelection: B, modelOverride: A },
    { modelSelection: null as unknown as GatewaySubmitTurnInput['modelSelection'] },
  ]) {
    const events = await f.submit(input.modelSelection, input.modelOverride);
    assert.equal(events.some((event) => event.type === 'input_accepted'), false);
  }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.saved(), A);
});

test('global model catalog needs no project registration and ignores legacy project scope', async (t) => {
  const f = await fixture(t);
  const global = await f.gateway.modelCatalogList!({ includeAuto: true });
  const unregistered = await f.gateway.modelCatalogList!({ projectKey: '/not-a-registered-project', includeAuto: true });
  assert.deepEqual(unregistered, global);
  assert.deepEqual(global.defaultSelection, { mode: 'model', provider: B.provider, model: B.model });
});

test('a new explicit snapshot overrides an old session preference after restart', async (t) => {
  const f = await fixture(t);
  await f.submit(A);
  f.restart();
  await f.submit(B);
  assert.equal(f.requests.at(-1)!.provider, B.provider);
  assert.equal(f.requests.at(-1)!.model, B.model);
  assert.equal(f.requests.at(-1)!.temperature, B.temperature);
});
