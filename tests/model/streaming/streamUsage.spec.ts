import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelRuntime } from '../../../src/model/ModelRuntime.js';
import { parseModelConfig } from '../../../src/model/config/parseModelConfig.js';
import type { CanonicalModelEvent, CanonicalUsage } from '../../../src/model/protocol/canonical.js';
import { applyModelEventToAssembler, assembleAssistantMessage, createModelMessageAssemblerState } from '../../../src/model/streaming/assembleModelMessage.js';

const request = { provider: 'test', model: 'model', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }] };
function config(extraBody?: Record<string, unknown>, url = 'https://example.test/v1') {
  return parseModelConfig({ providers: { test: {
    protocol: 'openai', url, apiKey: 'fixture',
    retry: { streamMaxRetries: 0 }, extraBody, models: { model: {} },
  } } });
}
function completedStream(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}
async function collect(stream: AsyncIterable<CanonicalModelEvent>) {
  const events: CanonicalModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('OpenAI stream requests ask for usage and parse the trailing empty-choices chunk', async () => {
  let calls = 0;
  const runtime = createModelRuntime(config(), { fetch: async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    return new Response([
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}],"usage":null}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const events = await collect(runtime.stream(request));
  assert.equal(calls, 1);
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(events.find(event => event.type === 'usage')?.usage.totalTokens, 120);
});

test('cumulative OpenAI stream usage is assembled once per request', async () => {
  const runtime = createModelRuntime(config(), { fetch: async () => new Response([
    'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":100,"completion_tokens":1,"total_tokens":101}}\n\n',
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":2,"total_tokens":102}}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":3,"total_tokens":103}}\n\n',
    'data: [DONE]\n\n',
  ].join(''), { headers: { 'content-type': 'text/event-stream' } }) });
  const assembler = createModelMessageAssemblerState();
  const events = await collect(runtime.stream(request));
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(events.filter(event => event.type === 'usage').length, 3);
  for (const event of events) applyModelEventToAssembler(assembler, event);
  const assembled = assembleAssistantMessage(assembler);
  assert.deepEqual(assembled.message.content, [{ type: 'text', text: 'hello world' }]);
  assert.equal(assembled.finishReason, 'stop');
  assert.equal(assembled.usage?.inputTokens, 100);
  assert.equal(assembled.usage?.outputTokens, 3);
  assert.equal(assembled.usage?.totalTokens, 103);
});

const partialUsageCases: { name: string; snapshots: Record<string, unknown>[]; expected: CanonicalUsage }[] = [
  { name: 'input then output', snapshots: [{ prompt_tokens: 100 }, { completion_tokens: 3 }],
    expected: { inputTokens: 100, outputTokens: 3, totalTokens: 103 } },
  { name: 'output then input', snapshots: [{ completion_tokens: 3 }, { prompt_tokens: 100 }],
    expected: { inputTokens: 100, outputTokens: 3, totalTokens: 103 } },
  { name: 'later cache details', snapshots: [
    { prompt_tokens: 100 }, { prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 } }, { completion_tokens: 3 },
  ], expected: { inputTokens: 55, outputTokens: 3, cacheReadTokens: 40, cacheWriteTokens: 5, totalTokens: 103 } },
  { name: 'updated aliases', snapshots: [
    { prompt_tokens: 100 }, { input_tokens: 80, output_tokens: 3, input_tokens_details: { cached_tokens: 40 } },
  ], expected: { inputTokens: 40, outputTokens: 3, cacheReadTokens: 40, totalTokens: 83 } },
  { name: 'explicit zeroes', snapshots: [
    { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 } },
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 0 },
  ], expected: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } },
  { name: 'omitted and invalid fields', snapshots: [
    { prompt_tokens: 100 }, { prompt_tokens: null, completion_tokens: 3 }, { completion_tokens: 'ignored' },
  ], expected: { inputTokens: 100, outputTokens: 3, totalTokens: 103 } },
  { name: 'explicit total zero before cache details', snapshots: [
    { prompt_tokens: 100, completion_tokens: 3, total_tokens: 0 }, { cache_read_input_tokens: 40 },
  ], expected: { inputTokens: 60, outputTokens: 3, cacheReadTokens: 40, totalTokens: 0 } },
];
for (const { name, snapshots, expected } of partialUsageCases) {
  test(`partial OpenAI stream usage preserves a complete snapshot: ${name}`, async () => {
    const runtime = createModelRuntime(config(), { fetch: async () => new Response([
      ...snapshots.map(usage => `data: ${JSON.stringify({ choices: [], usage })}\n\n`),
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }) });
    const assembler = createModelMessageAssemblerState();
    const events = await collect(runtime.stream(request));
    assert.equal(events.some(event => event.type === 'error'), false);
    for (const event of events) applyModelEventToAssembler(assembler, event);
    assert.deepEqual(assembleAssistantMessage(assembler).usage, {
      inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined,
      cacheWriteTokens: undefined, totalTokens: undefined, ...expected,
    });
  });
}

test('assembled usage adds interrupted and continuation requests using each latest snapshot', async () => {
  const retryConfig = config();
  retryConfig.providers.test!.retry = { streamMaxRetries: 1, baseDelayMs: 1, jitter: 0 };
  let calls = 0;
  const runtime = createModelRuntime(retryConfig, { fetch: async () => {
    calls++;
    const chunks = calls === 1 ? [
      'data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":100,"completion_tokens":1}}\n\n',
      'data: {"choices":[],"usage":{"completion_tokens":2}}\n\n',
    ] : [
      'data: {"choices":[{"delta":{"content":" world"}}],"usage":{"completion_tokens":1}}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":110,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ];
    return new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const assembler = createModelMessageAssemblerState();
  const events = await collect(runtime.stream(request));
  assert.equal(calls, 2);
  assert.equal(events.filter(event => event.type === 'request_started').length, 2);
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.deepEqual(events.filter(event => event.type === 'usage').map(event => event.usage.totalTokens), [101, 102, 1, 113]);
  for (const event of events) applyModelEventToAssembler(assembler, event);
  const assembled = assembleAssistantMessage(assembler);
  assert.deepEqual(assembled.message.content, [{ type: 'text', text: 'hello world' }]);
  assert.equal(assembled.usage?.inputTokens, 210);
  assert.equal(assembled.usage?.outputTokens, 5);
  assert.equal(assembled.usage?.totalTokens, 215);
});

const compatibilityCases = [400, 422].flatMap(status =>
  ['https://example.test/v1', 'https://example.test'].map(baseUrl => ({ status, baseUrl })));
for (const { status, baseUrl } of compatibilityCases) {
  test(`an unsupported stream_options error (${status}, base ${baseUrl}) retries the same endpoint`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    const runtime = createModelRuntime(config(undefined, baseUrl), { fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      urls.push(String(url));
      if (String(url) !== 'https://example.test/v1/chat/completions') {
        return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
      }
      if (body.stream_options) {
        return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'stream_options'" } }), { status });
      }
      return completedStream();
    } });
    const events = await collect(runtime.stream(request));
    assert.equal(bodies.length, 2);
    assert.deepEqual(urls, ['https://example.test/v1/chat/completions', 'https://example.test/v1/chat/completions']);
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });
    assert.equal(bodies[1].stream_options, undefined);
    assert.deepEqual(bodies[1], Object.fromEntries(Object.entries(bodies[0]).filter(([key]) => key !== 'stream_options')));
    assert.equal(events.some(event => event.type === 'error'), false);
    assert.ok(events.some(event => event.type === 'text_delta' && event.text === 'hello'));
    assert.equal(events.some(event => event.type === 'usage'), false);
  });
}

test('endpoint discovery still works when the second address requires a usage-option retry', async () => {
  const calls: { url: string; usage: boolean }[] = [];
  const runtime = createModelRuntime(config(undefined, 'https://example.test'), { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), usage: body.stream_options?.include_usage === true });
    if (String(url) === 'https://example.test/v1/chat/completions') {
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 });
    }
    if (body.stream_options) {
      return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'stream_options'" } }), { status: 400 });
    }
    return completedStream();
  } });
  const events = await collect(runtime.stream(request));
  assert.deepEqual(calls, [
    { url: 'https://example.test/v1/chat/completions', usage: true },
    { url: 'https://example.test/chat/completions', usage: true },
    { url: 'https://example.test/chat/completions', usage: false },
  ]);
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.ok(events.some(event => event.type === 'text_delta' && event.text === 'hello'));
});

test('unrelated bad requests are not retried as a usage compatibility fallback', async () => {
  let calls = 0;
  const runtime = createModelRuntime(config(), { fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'Invalid model' } }), { status: 400 });
  } });
  const events = await collect(runtime.stream(request));
  assert.equal(calls, 1);
  assert.ok(events.some(event => event.type === 'error'));
});

test('explicit provider stream_options overrides are preserved', async () => {
  const streamOptions = { include_usage: false };
  const runtime = createModelRuntime(config({ stream_options: streamOptions }), { fetch: async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).stream_options, streamOptions);
    return completedStream();
  } });
  assert.equal((await collect(runtime.stream(request))).some(event => event.type === 'error'), false);
});

test('explicit unsupported provider options are not silently overridden', async () => {
  let calls = 0;
  const runtime = createModelRuntime(config({ stream_options: { include_usage: true } }), { fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'stream_options is not supported' } }), { status: 400 });
  } });
  const events = await collect(runtime.stream(request));
  assert.equal(calls, 1);
  assert.ok(events.some(event => event.type === 'error'));
});

test('non-streaming completions do not add stream_options', async () => {
  const runtime = createModelRuntime(config(), { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, false);
    assert.equal(body.stream_options, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } }));
  } });
  assert.equal((await runtime.complete(request)).usage?.totalTokens, 12);
});
