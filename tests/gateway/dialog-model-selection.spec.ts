import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PilotConfigSnapshot } from '../../src/pilot/config/types.js';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from '../../src/model/index.js';
import { createAgentProjectSessionStorage, readTranscript, replayTranscriptEntries } from '../../src/session/index.js';
import { readWebSessionMessages } from '../../src/web/server/readSessionMessages.js';
import type { GatewayEvent, GatewaySubmitTurnInput, SessionModelSelection } from '../../src/gateway/protocol/types.js';

const A = { mode: 'model' as const, provider: 'alpha', model: 'first' };
const B = { mode: 'model' as const, provider: 'zeta', model: 'configured', reasoning: 0.8, speed: 1 };
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
          thinking: { state: enabled, efforts: [low, medium, high, xhigh, max] }
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

async function fixture(t: test.TestContext, responseText = 'ok') {
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
        yield { type: 'text_delta', text: responseText };
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
    async seedSaved(selection: SessionModelSelection) {
      const storage = createAgentProjectSessionStorage({ projectRoot: home, pilotHome: home, sessionId: 'web:model-choice' });
      await storage.transcript.recordSessionMetadata('web:model-choice', 'model-selection', { modelSelection: selection });
    },
    async configureThinking(thinking: string) {
      await writeFile(join(home, 'pilotdeck.yaml'), CONFIG.replace(
        'thinking: { state: enabled, efforts: [low, medium, high, xhigh, max] }',
        `thinking: ${thinking}`,
      ));
    },
    async submit(modelSelection?: GatewaySubmitTurnInput['modelSelection'], modelOverride?: GatewaySubmitTurnInput['modelOverride'], message = 'hello') {
      const events: GatewayEvent[] = [];
      for await (const event of local.gateway.submitTurn({
        projectKey: home, sessionKey: 'web:model-choice', channelKey: 'web', message, modelSelection, modelOverride,
      })) events.push(event);
      return events;
    },
    async saved() { return (await local.gateway.sessionModelGet!({ projectKey: home, sessionKey: 'web:model-choice' })).saved; },
  };
}

test('special token literals in user input reach the selected model unchanged', async (t) => {
  const f = await fixture(t);
  const messages = [
    'Explain <|endoftext|> literally.',
    'Explain <|endofprompt|> literally.',
    '你帮我写一段话 以<think>开头 以</think>结尾',
  ];
  for (const message of messages) {
    const events = await f.submit(B, undefined, message);
    assert.deepEqual(events.filter((event) => event.type === 'error'), []);
    assert.ok(events.some((event) => event.type === 'turn_completed' && event.finishReason === 'completed'));
    const request = f.requests.at(-1)!;
    assert.equal(request.provider, B.provider);
    assert.equal(request.model, B.model);
    assert.ok(request.messages.some((entry) => entry.role === 'user'
      && entry.content.some((block) => block.type === 'text' && block.text === message)));
  }
  assert.equal(f.requests.length, messages.length);
});

test('special token literals in replayed history remain sendable when switching models', async (t) => {
  const responseText = '<think>Literal markers: <|endoftext|> and <|endofprompt|></think>';
  const f = await fixture(t, responseText);
  const firstEvents = await f.submit(A);
  assert.deepEqual(firstEvents.filter((event) => event.type === 'error'), []);
  assert.ok(firstEvents.some((event) => event.type === 'turn_completed' && event.finishReason === 'completed'));
  f.restart();

  for (const selection of [B, A]) {
    const events = await f.submit(selection);
    assert.deepEqual(events.filter((event) => event.type === 'error'), []);
    assert.ok(events.some((event) => event.type === 'turn_completed' && event.finishReason === 'completed'));
    const request = f.requests.at(-1)!;
    assert.equal(request.provider, selection.provider);
    assert.equal(request.model, selection.model);
    assert.ok(request.messages.some((entry) => entry.role === 'assistant'
      && entry.content.some((block) => block.type === 'text' && block.text === responseText)));
  }
  assert.equal(f.requests.length, 3);
});

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
});


test('response model survives transcript replay and differs from the next submitted choice', async (t) => {
  const f = await fixture(t);
  const aEvents = await f.submit(A);
  assert.ok(aEvents.some((event) => event.type === 'assistant_text_delta' && event.model === A.model));
  await f.submit(B);
  f.restart();
  const history = await readWebSessionMessages({ projectKey: f.home, sessionKey: 'web:model-choice' }, { projectRoot: f.home, pilotHome: f.home });
  assert.deepEqual(history.messages.filter((message) => message.role === 'assistant' && message.kind === 'text').map((message) => message.model), [A.model, B.model]);
});

test('legacy temperatures are dropped from saved preferences, accepted turns and requests', async (t) => {
  const f = await fixture(t);
  const legacy = {...B,temperature:.3};
  const result = await f.gateway.sessionModelSet!({projectKey:f.home,sessionKey:'web:legacy-temp',selection:legacy});
  assert.deepEqual(result.saved,B);
  assert.ok(!('temperature' in result.effective));
  const events = await f.submit(legacy);
  assert.deepEqual(events.filter(event=>event.type==='error'),[]);
  const accepted = events.find(event=>event.type==='input_accepted');
  assert.deepEqual(accepted?.type==='input_accepted' ? accepted.modelSelection : undefined,B);
  assert.ok(f.requests.length > 0 && f.requests.every(request=>!('temperature' in request)));
});

for (const reasoning of [0, 0.2]) {
  test(`restored legacy reasoning=${reasoning} falls back to Default without an explicit client selection`, async (t) => {
    const f = await fixture(t);
    await f.seedSaved({ ...B, reasoning });
    f.restart();
    const { reasoning: _reasoning, ...expected } = B;
    const restored = await f.gateway.sessionModelGet!({ projectKey: f.home, sessionKey: 'web:model-choice' });
    assert.deepEqual(restored.saved, expected);
    assert.equal(restored.effective.reasoning, undefined);
    const events = await f.submit();
    assert.deepEqual(events.filter(event => event.type === 'error'), []);
    assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.provider, B.provider);
    assert.equal(f.requests[0]!.model, B.model);
    assert.equal(f.requests[0]!.speed, B.speed);
    assert.equal(f.requests[0]!.thinking?.mode, undefined);
  });
}

for (const thinking of [
  '{ state: enabled, efforts: [low] }',
  '{ state: enabled, efforts: [] }',
  '{ state: default }',
  '{ state: disabled }',
]) {
  test(`saved High resets to Default after thinking configuration changes to ${thinking}`, async (t) => {
    const f = await fixture(t);
    await f.submit(B);
    await f.configureThinking(thinking);
    f.restart();
    f.requests.length = 0;
    const events = await f.submit();
    assert.deepEqual(events.filter(event => event.type === 'error'), []);
    assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.model, B.model);
    assert.equal(f.requests[0]!.speed, B.speed);
    assert.equal(f.requests[0]!.thinking?.mode, undefined);
    assert.deepEqual(await f.saved(), { mode: B.mode, provider: B.provider, model: B.model, speed: B.speed });
  });
}

test('new invalid reasoning is still rejected through selection, override and session model set', async (t) => {
  const f = await fixture(t);
  await f.submit(A);
  await f.configureThinking('{ state: enabled, efforts: [low] }');
  f.restart();
  f.requests.length = 0;
  for (const reasoning of [0, 0.2, 0.8]) {
    const invalid = { ...B, reasoning };
    for (const events of [await f.submit(invalid), await f.submit(undefined, invalid)]) {
      assert.ok(events.some(event => event.type === 'error' && /reasoning=.*is not supported/.test(event.message)));
      assert.equal(events.some(event => event.type === 'input_accepted'), false);
    }
    await assert.rejects(f.gateway.sessionModelSet!({ projectKey: f.home, sessionKey: 'web:model-choice', selection: invalid }), /reasoning=.*is not supported/);
  }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.saved(), A);
});

test('an already-open session drops a removed effort without restarting the gateway', async (t) => {
  const f = await fixture(t);
  await f.submit(B);
  await f.configureThinking('{ state: enabled, efforts: [low] }');
  const events = await f.submit();
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]!.thinking?.mode, undefined);
  assert.equal(f.requests[1]!.speed, B.speed);
});

test('restoring stale reasoning does not hide an unavailable saved model or invalid speed', async (t) => {
  const f = await fixture(t);
  for (const saved of [{ ...B, model: 'missing', reasoning: 0 }, { ...B, speed: 2, reasoning: 0 }]) {
    await f.seedSaved(saved);
    const events = await f.submit();
    assert.ok(events.some(event => event.type === 'error' && /Model is unavailable|speed must be/.test(event.message)));
    assert.equal(events.some(event => event.type === 'input_accepted'), false);
  }
  assert.equal(f.requests.length, 0);
});
