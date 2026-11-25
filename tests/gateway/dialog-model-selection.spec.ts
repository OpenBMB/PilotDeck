import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import type { PilotConfigSnapshot } from '../../src/pilot/config/types.js';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { buildOpenAIRequest } from '../../src/model/providers/openai/request.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest, type ModelRuntime } from '../../src/model/index.js';
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
  zeroUsageRetry:
    enabled: false
  transientRetry:
    enabled: false
`;

async function fixture(t: test.TestContext, responseText = 'ok', routing: {
  config?: string;
  judgeReply?: string;
  reply?: (request: CanonicalModelRequest, index: number) => CanonicalModelEvent[] | undefined;
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-model-choice-'));
  await writeFile(join(home, 'pilotdeck.yaml'), routing.config ?? CONFIG);
  await mkdir(join(home, 'skills'), { recursive: true });
  const requests: CanonicalModelRequest[] = [];
  let modelConfig: PilotConfigSnapshot['config']['model'];
  let failZeta = false;
  const options = {
    pilotHome: home, projectRoot: home,
    env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
    builtinSkillsRoot: join(home, 'skills'),
    __testModelFactory: (snapshot: PilotConfigSnapshot): ModelRuntime => {
      modelConfig = snapshot.config.model;
      return {
        ...createModelRuntime(modelConfig),
        async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
          requests.push(request);
          yield { type: 'request_started', provider: request.provider, model: request.model };
          const reply = routing.reply?.(request, requests.length);
          if (reply) {
            yield* reply;
            return;
          }
          if (failZeta && request.provider === 'zeta') {
            yield { type: 'error', error: { provider: request.provider, protocol: 'openai', code: 'auth_error', message: 'test failure', retryable: false } };
            return;
          }
          yield { type: 'message_start', role: 'assistant' };
          yield { type: 'text_delta', text: responseText };
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } };
          yield { type: 'message_end', finishReason: 'stop' };
        },
        async complete() {
          return { role: 'assistant', content: [{ type: 'text', text: routing.judgeReply ?? '' }], finishReason: 'stop' };
        },
      };
    },
  };
  let local = createLocalGateway(options);
  t.after(async () => { local.dispose(); await rm(home, { recursive: true, force: true }); });
  return {
    home, requests,
    wireBody(index: number) {
      const request = requests[index]!;
      const provider = modelConfig.providers[request.provider];
      return buildOpenAIRequest(request, provider.models[request.model], provider);
    },
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
    async submit(
      modelSelection?: GatewaySubmitTurnInput['modelSelection'],
      modelOverride?: GatewaySubmitTurnInput['modelOverride'],
      message = 'hello',
      extra?: Pick<GatewaySubmitTurnInput, 'attachments' | 'mode'>,
    ) {
      const events: GatewayEvent[] = [];
      for await (const event of local.gateway.submitTurn({
        projectKey: home, sessionKey: 'web:model-choice', channelKey: 'web', message, modelSelection, modelOverride, ...extra,
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

test('concrete choices fail without silently falling back, while Auto uses the model pool', async (t) => {
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

const TEXT_DEFAULT_CONFIG = CONFIG
  .replace('        first: {}', '        first: { multimodal: { input: [text, image], imageDetail: low } }')
  .replace('        configured:\n', '        configured:\n          multimodal: { input: [text] }\n');

function readFileReply(filePath: string): CanonicalModelEvent[] {
  const toolCall = { id: 'read-test-file', name: 'read_file', input: { file_path: filePath } };
  return [
    { type: 'message_start', role: 'assistant' },
    { type: 'tool_call_start', id: toolCall.id, name: toolCall.name },
    { type: 'tool_call_end', toolCall },
    { type: 'message_end', finishReason: 'tool_call' },
  ];
}

function requestImages(request: CanonicalModelRequest) {
  return request.messages.flatMap(message => message.content.flatMap(block => {
    if (block.type === 'image') return [block];
    if (block.type === 'tool_result') return block.content.filter(part => part.type === 'image');
    return [];
  }));
}

function pngUpload(png: Buffer): Pick<GatewaySubmitTurnInput, 'attachments'> {
  return { attachments: [{ type: 'image', name: 'synthetic.png', mimeType: 'image/png', content: png.toString('base64'), bytes: png.length }] };
}

function noisyPng(width: number) {
  return sharp(randomBytes(width * width * 3), { raw: { width, height: width, channels: 3 } }).png().toBuffer();
}

for (const large of [false, true]) {
  test(`Auto sends a ${large ? 'persisted' : 'small inline'} read_file image to a vision model configured only in the pool`, async t => {
    const f = await fixture(t, 'image inspected', {
      config: TEXT_DEFAULT_CONFIG,
      reply: (_request, index) => index === 1 ? readFileReply('synthetic.png') : undefined,
    });
    const size = large ? 300 : 30;
    const png = await sharp(randomBytes(size * size * 3), {
      raw: { width: size, height: size, channels: 3 },
    }).png().toBuffer();
    await writeFile(join(f.home, 'synthetic.png'), png);

    const events = await f.submit({ mode: 'auto' }, undefined, 'Inspect synthetic.png');
    assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
    const tool = events.find(event => event.type === 'tool_call_finished' && event.toolName === 'read_file');
    assert.ok(tool?.type === 'tool_call_finished' && tool.ok, JSON.stringify(tool));
    assert.deepEqual(f.requests.map(request => request.provider), ['zeta', 'alpha']);
    const [image] = requestImages(f.requests[1]!);
    assert.equal(image?.mimeType, 'image/png');
    assert.equal(image?.detail, 'low');
    assert.deepEqual(Buffer.from(image!.data!, 'base64'), png);
    assert.ok(JSON.stringify(f.wireBody(1)).includes('data:image/png;base64,' + png.toString('base64')));
    assert.ok(f.requests[1]!.messages.some(message => message.content.some(block =>
      block.type === 'tool_result' && block.toolCallId === 'read-test-file')));
    assert.ok(!events.some(event => event.type === 'agent_status' && event.event === 'model_images_omitted'));

    const storage = createAgentProjectSessionStorage({ projectRoot: f.home, pilotHome: f.home, sessionId: 'web:model-choice' });
    const history = replayTranscriptEntries((await readTranscript(storage.transcriptPath)).entries);
    const blocks = history.messages.flatMap(message => message.content);
    assert.equal(blocks.some(block => block.type === 'media_reference' && block.mediaType === 'image'), large);
  });
}

test('an uploaded PNG uses an eligible model from the pool without making a text-only attempt', async t => {
  const config = TEXT_DEFAULT_CONFIG.replace('        first: { multimodal: { input: [text, image], imageDetail: low } }', `        first:
          multimodal: { input: [text, image], supportedImageMimeTypes: [image/jpeg] }
        second: { multimodal: { input: [text, image], maxImageBytes: 1 } }
        third: { multimodal: { input: [text, image] } }
`);
  const f = await fixture(t, 'upload inspected', { config });
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  await f.submit({ mode: 'auto' }, undefined, 'Inspect the upload', {
    attachments: [{ type: 'image', name: 'synthetic.png', mimeType: 'image/png', content: png.toString('base64'), bytes: png.length }],
  });
  assert.deepEqual(f.requests.map(request => [request.provider, request.model]), [['alpha', 'third']]);
  assert.equal(requestImages(f.requests[0]!)[0]?.mimeType, 'image/png');
});

test('a new upload takes precedence over history when the model accepts only one image', async t => {
  const config = TEXT_DEFAULT_CONFIG.replace('input: [text, image], imageDetail: low', 'input: [text, image], maxImagesPerRequest: 1');
  const f = await fixture(t, 'image inspected', { config });
  const png = (background: string) => sharp({ create: { width: 24, height: 24, channels: 3, background } }).png().toBuffer();
  const [oldImage, newImage] = await Promise.all([png('red'), png('blue')]);
  for (const image of [oldImage, newImage]) {
    const events = await f.submit({ mode: 'auto' }, undefined, 'Inspect this upload', {
      attachments: [{ type: 'image', name: 'synthetic.png', mimeType: 'image/png', content: image.toString('base64'), bytes: image.length }],
    });
    assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
    assert.deepEqual(requestImages(f.requests.at(-1)!).map(block => block.data), [image.toString('base64')]);
  }
});

test('read_file compresses for the selected model before dispatch while retaining the original in history', async t => {
  const limit = 512 * 1024;
  const config = TEXT_DEFAULT_CONFIG.replace('input: [text, image], imageDetail: low', `input: [text, image], maxImageBytes: ${limit}`);
  const f = await fixture(t, 'image inspected', {
    config,
    reply: (_request, index) => index === 1 ? readFileReply('large.png') : undefined,
  });
  const png = await noisyPng(700);
  assert.ok(png.length > limit);
  await writeFile(join(f.home, 'large.png'), png);

  const events = await f.submit({ mode: 'auto' }, undefined, 'Inspect large.png');
  assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
  assert.deepEqual(f.requests.map(request => request.provider), ['zeta', 'alpha']);
  const [image] = requestImages(f.requests[1]!);
  assert.ok(image?.bytes && image.bytes <= limit);
  assert.equal(Buffer.from(image.data, 'base64').length, image.bytes);
  assert.equal((await sharp(Buffer.from(image.data, 'base64')).metadata()).format, 'jpeg');
  assert.ok(JSON.stringify(f.wireBody(1)).includes('data:image/jpeg;base64,' + image.data));
  assert.ok(!events.some(event => event.type === 'agent_status' && event.event === 'model_images_omitted'));

  const storage = createAgentProjectSessionStorage({ projectRoot: f.home, pilotHome: f.home, sessionId: 'web:model-choice' });
  const history = replayTranscriptEntries((await readTranscript(storage.transcriptPath)).entries);
  assert.ok(history.messages.some(message => message.content.some(block =>
    block.type === 'media_reference' && block.mediaType === 'image' && block.originalBytes === png.length)));
});

test('Auto probes a recovered vision provider even with a healthy text-only model', async t => {
  const config = TEXT_DEFAULT_CONFIG.replace('  zeroUsageRetry:', '  tokenSaver: { enabled: false }\n  zeroUsageRetry:');
  let offline = true;
  const f = await fixture(t, 'image inspected', {
    config,
    reply: request => offline && request.provider === 'alpha' ? [{ type: 'error', error: {
      provider: 'alpha', protocol: 'openai', code: 'connection_refused', message: 'Synthetic outage', retryable: false, retryAfterMs: 0,
    } }] : undefined,
  });
  const firstImage = await noisyPng(20);
  const freshImage = await noisyPng(21);
  const failed = await f.submit({ mode: 'auto' }, undefined, 'Inspect the first image', pngUpload(firstImage));
  assert.ok(failed.some(event => event.type === 'turn_completed' && event.finishReason === 'model_error'));
  const failedAttempts = f.requests.length;
  assert.ok(failedAttempts >= 5, 'Failed requests must open the vision provider circuit');
  assert.ok(f.requests.every(request => request.provider === 'alpha'));

  offline = false;
  const recovered = await f.submit({ mode: 'auto' }, undefined, 'Inspect the new image', pngUpload(freshImage));
  assert.ok(recovered.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
  assert.equal(f.requests.length, failedAttempts + 1);
  assert.equal(f.requests[failedAttempts]?.provider, 'alpha');
  assert.ok(requestImages(f.requests[failedAttempts]!).some(image => image.data === freshImage.toString('base64')));
});

test('Auto failover skips a model that cannot accept a system prompt', async t => {
  const config = CONFIG.replace('        first: {}', '        first: { capabilities: { supportsSystemPrompt: false } }\n        second: {}');
  const f = await fixture(t, 'done', {
    config,
    reply: request => request.provider === 'zeta' ? [{ type: 'error', error: {
      provider: 'zeta', protocol: 'openai', code: 'rate_limit_error', message: 'Synthetic limit', retryable: true,
    } }] : undefined,
  });
  const events = await f.submit({ mode: 'auto' });
  assert.ok(f.requests[0]?.systemPrompt);
  assert.deepEqual(f.requests.map(request => [request.provider, request.model]), [['zeta', 'configured'], ['alpha', 'second']]);
  assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
});

test('Auto considers the JPEG output of resizing an oversized PNG', async t => {
  const limit = 512 * 1024;
  const config = TEXT_DEFAULT_CONFIG.replace('input: [text, image], imageDetail: low',
    `input: [text, image], supportedImageMimeTypes: [image/jpeg], maxImageBytes: ${limit}`);
  const f = await fixture(t, 'image inspected', { config });
  const png = await noisyPng(700);
  assert.ok(png.length > limit);
  const events = await f.submit({ mode: 'auto' }, undefined, 'Inspect the PNG upload', pngUpload(png));
  assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
  assert.deepEqual(f.requests.map(request => request.provider), ['alpha']);
  const [image] = requestImages(f.requests[0]!);
  assert.ok(image?.bytes && image.bytes <= limit);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal((await sharp(Buffer.from(image.data, 'base64')).metadata()).format, 'jpeg');
});

for (const mode of ['no-vision', 'explicit', 'router-disabled'] as const) {
  test(`read_file retains the image in history and reports wire omission in ${mode} mode`, async t => {
    let config = TEXT_DEFAULT_CONFIG;
    if (mode === 'no-vision') config = config.replace('        first: { multimodal: { input: [text, image], imageDetail: low } }', '        first: { multimodal: { input: [text] } }');
    if (mode === 'router-disabled') config = config.replace('router:\n  enabled: true', 'router:\n  enabled: false');
    const f = await fixture(t, 'I cannot see the image', {
      config,
      reply: (_request, index) => index === 1 ? readFileReply('synthetic.png') : undefined,
    });
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer();
    await writeFile(join(f.home, 'synthetic.png'), png);
    const selection = mode === 'explicit' ? B : mode === 'no-vision' ? { mode: 'auto' as const } : undefined;
    const events = await f.submit(selection, undefined, 'Inspect synthetic.png');
    assert.deepEqual(f.requests.map(request => request.provider), ['zeta', 'zeta']);
    assert.equal(requestImages(f.requests[1]!).length, 0);
    assert.match(JSON.stringify(f.requests[1]!.messages), /omitted, Model does not support image input/);
    assert.equal(events.filter(event => event.type === 'agent_status' && event.event === 'model_images_omitted').length, 1);

    const storage = createAgentProjectSessionStorage({ projectRoot: f.home, pilotHome: f.home, sessionId: 'web:model-choice' });
    const history = replayTranscriptEntries((await readTranscript(storage.transcriptPath)).entries);
    assert.ok(history.messages.some(message => message.content.some(block =>
      block.type === 'tool_result' && block.content.some(part => part.type === 'image'))));
  });
}

test('Auto skips models that cannot receive the current tool schemas', async t => {
  const config = CONFIG.replace('            supportsSpeed: true', '            supportsSpeed: true\n            supportsToolUse: false');
  const f = await fixture(t, 'done', { config });
  await f.submit({ mode: 'auto' }, undefined, 'Inspect the workspace');
  assert.deepEqual(f.requests.map(request => request.provider), ['alpha']);
  assert.ok(f.requests[0]?.tools?.some(tool => tool.name === 'read_file'));
});

test('an eligible vision model failure does not silently omit an uploaded image', async t => {
  const f = await fixture(t, 'done', {
    config: TEXT_DEFAULT_CONFIG,
    reply: request => [{ type: 'error', error: {
      provider: request.provider, protocol: 'openai', code: 'auth_error', message: 'Synthetic vision fault', retryable: false, retryAfterMs: 0,
    } }],
  });
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  const events = await f.submit({ mode: 'auto' }, undefined, 'Inspect the upload', {
    attachments: [{ type: 'image', name: 'synthetic.png', mimeType: 'image/png', content: png.toString('base64'), bytes: png.length }],
  });
  assert.deepEqual([...new Set(f.requests.map(request => request.provider))], ['alpha']);
  assert.ok(f.requests.every(request => requestImages(request).length === 1));
  assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'model_error'));
  assert.ok(!events.some(event => event.type === 'agent_status' && event.event === 'model_images_omitted'));
});

test('Auto reuses the successful failover within a turn and starts the next turn with its normal route', async t => {
  const f = await fixture(t, 'done', {
    config: CONFIG.replace('  zeroUsageRetry:', '  tokenSaver: { enabled: false }\n  zeroUsageRetry:'),
    reply: (_request, index) => {
      if (index === 1) return [{ type: 'error', error: {
        provider: 'zeta', protocol: 'openai', code: 'rate_limit_error', message: 'Synthetic limit', retryable: true,
      } }];
      if (index === 2) return readFileReply('synthetic.txt');
      return undefined;
    },
  });
  await writeFile(join(f.home, 'synthetic.txt'), 'synthetic text');
  await f.submit({ mode: 'auto' }, undefined, 'Read synthetic.txt');
  await f.submit(undefined, undefined, 'New task');
  assert.deepEqual(f.requests.map(request => request.provider), ['zeta', 'alpha', 'alpha', 'zeta']);
});

test('Auto considers the successful failover cache on the next user message', async t => {
  const f = await fixture(t, 'done', {
    judgeReply: '<tier>simple</tier>',
    config: CONFIG.replace('  zeroUsageRetry:', `  fallback: { default: [removed/legacy] }
  tokenSaver:
    enabled: true
    judge: zeta/configured
    defaultTier: simple
    cacheAwareSwitching: { enabled: false }
    tiers:
      simple: { model: zeta/configured }
      medium: { model: alpha/first }
  stats:
    enabled: false
    modelPricing:
      zeta/configured: { input: 3 }
      alpha/first: { input: 10, cacheRead: 1 }
  zeroUsageRetry:`),
    reply: request => request.provider === 'alpha' ? [
      { type: 'text_delta', text: 'Synthetic answer' },
      { type: 'usage', usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 9000 } },
      { type: 'message_end', finishReason: 'stop' },
    ] : undefined,
  });

  f.fail();
  await f.submit({ mode: 'auto' }, undefined, 'Synthetic first task');
  const events = await f.submit(undefined, undefined, 'Synthetic follow-up');
  assert.deepEqual(f.requests.map(request => request.provider), ['zeta', 'alpha', 'alpha']);
  assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
});

for (const size of ['small', 'oversized', 'unpriced'] as const) {
  test(`Auto compares eligible priced models using the projected request (${size})`, async t => {
    const limit = 512 * 1024;
    const vision = `multimodal: { input: [text, image], maxImageBytes: ${limit} }`;
    const config = CONFIG.replace('        first: {}', `        first: { ${vision} }`)
      .replace('        configured:\n', `        configured:\n          ${vision}\n`)
      .replace('  zeroUsageRetry:', `  tokenSaver:
    enabled: true
    judge: zeta/configured
    defaultTier: simple
    tiers:
      simple: { model: zeta/configured }
      medium: { model: alpha/first }
  stats:
    enabled: false
    modelPricing:
      zeta/configured: { input: 3 }${size === 'unpriced' ? '' : '\n      alpha/first: { input: 10, cacheRead: 1 }'}
  zeroUsageRetry:`);
    const f = await fixture(t, 'done', {
      config,
      judgeReply: '<tier>simple</tier>',
      reply: request => request.provider === 'alpha' && size !== 'unpriced' ? [
        { type: 'text_delta', text: 'Synthetic answer' },
        { type: 'usage', usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 9000 } },
        { type: 'message_end', finishReason: 'stop' },
      ] : undefined,
    });
    const upload = size === 'unpriced' ? undefined : pngUpload(await noisyPng(size === 'small' ? 30 : 700));
    await f.submit(A, undefined, 'Inspect the provided context', upload);
    const events = await f.submit({ mode: 'auto' }, undefined, 'Summarize the previous result');
    assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
    assert.deepEqual(f.requests.map(request => request.provider), ['alpha', size === 'unpriced' ? 'zeta' : 'alpha']);
    if (upload) {
      const [image] = requestImages(f.requests[1]!);
      assert.ok(image?.bytes && image.bytes <= limit);
      assert.equal(image.mimeType, size === 'small' ? 'image/png' : 'image/jpeg');
    }
  });
}

test('Auto does not switch models after it has streamed answer text', async t => {
  const f = await fixture(t, 'done', {
    reply: () => [
      { type: 'message_start', role: 'assistant' },
      { type: 'text_delta', text: 'Visible partial output' },
      { type: 'error', error: { provider: 'zeta', protocol: 'openai', code: 'auth_error', message: 'Synthetic fault', retryable: false } },
    ],
  });
  const events = await f.submit({ mode: 'auto' });
  assert.deepEqual(f.requests.map(request => request.provider), ['zeta']);
  assert.ok(events.some(event => event.type === 'assistant_text_delta'));
});
