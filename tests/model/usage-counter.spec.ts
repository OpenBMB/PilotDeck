import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRuntime } from '../../src/model/ModelRuntime.js';
import type { CanonicalModelEvent, CanonicalModelResponse } from '../../src/model/protocol/canonical.js';
import { UsageCounter, withUsageCounter } from '../../src/model/usage/UsageCounter.js';

const request = { provider: 'test', model: 'model', messages: [] };
function model(events: CanonicalModelEvent[], response?: CanonicalModelResponse, protocol = 'openai'): ModelRuntime {
  return {
    async *stream() { yield* events; },
    async complete() { return response ?? { role: 'assistant', content: [], finishReason: 'stop' }; },
    getCapabilities() { throw new Error('unused in this fixture'); },
    getMultimodal() { throw new Error('unused in this fixture'); },
    getProviderProtocol() { return protocol as 'openai'; },
    getProviderBaseUrl() { return undefined; },
  } as ModelRuntime;
}

test('daily counter persists concurrent calls across Beijing midnight and restart', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-usage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = new Date('2026-10-12T15:59:59Z');
  const counter = new UsageCounter(home, () => now);
  counter.record(10); counter.record(20);
  now = new Date('2026-10-12T16:00:00Z');
  counter.record(30); counter.record(-1); counter.record(NaN);
  await counter.flush();
  const restarted = new UsageCounter(home, () => now);
  restarted.record(40);
  await restarted.flush();
  assert.equal(await readFile(join(home, 'usage/daily/2026-10-12.jsonl'), 'utf8'), '10\n20\n');
  assert.equal(await readFile(join(home, 'usage/daily/2026-10-13.jsonl'), 'utf8'), '30\n40\n');
});

test('stream forwards identical events and records the latest usage once', async () => {
  const events: CanonicalModelEvent[] = [
    { type: 'request_started', provider: 'test', model: 'model' },
    { type: 'text_delta', text: 'hello' },
    { type: 'usage', usage: { totalTokens: 12 } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } },
    { type: 'message_end', finishReason: 'stop' },
  ];
  const tokens: number[] = [];
  const seen: CanonicalModelEvent[] = [];
  for await (const event of withUsageCounter(model(events), { record: n => { tokens.push(n); } }).stream(request)) seen.push(event);
  assert.deepEqual(tokens, [18]);
  seen.forEach((event, i) => assert.equal(event, events[i]));
});

test('title generation still executes and forwards results without adding usage', async () => {
  const events: CanonicalModelEvent[] = [{ type: 'usage', usage: { totalTokens: 5 } }];
  const response: CanonicalModelResponse = { role: 'assistant', content: [], finishReason: 'stop', usage: { totalTokens: 5 } };
  const base = model(events, response);
  const title = { ...request, metadata: { purpose: 'session_title_generation' } };
  const options = { signal: new AbortController().signal };
  let completions = 0;
  let streams = 0;
  base.complete = async (input, callOptions) => {
    assert.equal(input, title); assert.equal(callOptions, options);
    completions++;
    return response;
  };
  base.stream = async function* (input, callOptions) {
    assert.equal(input, title); assert.equal(callOptions, options);
    streams++;
    yield* events;
  };
  const tokens: number[] = [];
  const wrapped = withUsageCounter(base, { record: n => { tokens.push(n); } });
  assert.equal(await wrapped.complete(title, options), response);
  const seen: CanonicalModelEvent[] = [];
  for await (const event of wrapped.stream(title, options)) seen.push(event);
  assert.equal(completions, 1);
  assert.equal(streams, 1);
  assert.equal(seen[0], events[0]);
  assert.deepEqual(tokens, []);
});

test('non-title completion calls remain counted, including routing judgments', async () => {
  const response: CanonicalModelResponse = { role: 'assistant', content: [], finishReason: 'stop', usage: { totalTokens: 12 } };
  const tokens: number[] = [];
  const wrapped = withUsageCounter(model([], response), { record: n => { tokens.push(n); } });
  assert.equal(await wrapped.complete(request), response);
  assert.equal(await wrapped.complete({ ...request, metadata: { purpose: 'other' } }), response);
  assert.deepEqual(tokens, [12, 12]);
});

test('Anthropic input/cache and output reports combine without changing usage events', async () => {
  const events: CanonicalModelEvent[] = [
    { type: 'message_start', role: 'assistant', raw: { message: { usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } } },
    { type: 'usage', usage: { outputTokens: 7, totalTokens: 7 } },
  ];
  const tokens: number[] = [];
  for await (const _event of withUsageCounter(model(events, undefined, 'anthropic'), { record: n => { tokens.push(n); } }).stream(request)) { /* drain */ }
  assert.deepEqual(tokens, [42]);
  assert.deepEqual(events[1], { type: 'usage', usage: { outputTokens: 7, totalTokens: 7 } });
});

test('reported retry/continuation usage counts separately; missing usage is excluded', async () => {
  const events: CanonicalModelEvent[] = [
    { type: 'request_started', provider: 'test', model: 'model' },
    { type: 'usage', usage: { totalTokens: 5 } },
    { type: 'request_started', provider: 'test', model: 'model' },
    { type: 'request_started', provider: 'test', model: 'model' },
    { type: 'usage', usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 } },
  ];
  const tokens: number[] = [];
  for await (const _event of withUsageCounter(model(events), { record: n => { tokens.push(n); } }).stream(request)) { /* drain */ }
  assert.deepEqual(tokens, [5, 10]);
});

test('observation and filesystem errors cannot fail a completion or stream', async t => {
  const response: CanonicalModelResponse = { role: 'assistant', content: [], finishReason: 'stop', usage: { totalTokens: 12 } };
  const wrapped = withUsageCounter(model([{ type: 'usage', usage: { totalTokens: 12 } }], response), { record() { throw new Error('counter unavailable'); } });
  assert.equal(await wrapped.complete(request), response);
  for await (const _event of wrapped.stream(request)) { /* drain */ }
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-usage-unwritable-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'usage'), 'blocks directory creation');
  const counter = new UsageCounter(home);
  assert.equal(await withUsageCounter(model([], response), counter).complete(request), response);
  await counter.flush();
});

test('model errors and cancellation still propagate and do not invent usage', async () => {
  const failure = new Error('provider failure');
  const base = model([]);
  base.complete = async () => { throw failure; };
  base.stream = async function* () { yield { type: 'text_delta', text: 'partial' }; throw failure; };
  const tokens: number[] = [];
  const wrapped = withUsageCounter(base, { record: n => { tokens.push(n); } });
  await assert.rejects(wrapped.complete(request), error => error === failure);
  await assert.rejects(async () => { for await (const _event of wrapped.stream(request)) { /* drain */ } }, error => error === failure);
  assert.deepEqual(tokens, []);
  const controller = new AbortController();
  let closed = false;
  base.stream = async function* (input, options) {
    assert.equal(input, request); assert.equal(options?.signal, controller.signal);
    try { yield { type: 'usage', usage: { totalTokens: 8 } }; yield { type: 'text_delta', text: 'next' }; }
    finally { closed = true; }
  };
  for await (const _event of wrapped.stream(request, { signal: controller.signal })) break;
  assert.equal(closed, true);
  assert.deepEqual(tokens, [8]);
});
