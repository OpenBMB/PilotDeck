import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonicalModelRequest, CanonicalModelResponse } from '../../../../src/model/index.js';

async function factory() {
  const module = await import('../../../../src/agent/sub/delivery/reviewer.js').catch(() => undefined);
  assert.equal(typeof module?.createDeliveryReviewer, 'function', 'a bounded delivery reviewer must exist');
  return module!.createDeliveryReviewer;
}
const packet = { text: 'TASK: explain this result. DELIVERY: two plus two equals four.', tokenCount: 20, complete: true, hasContent: true, warnings: [] };
const input = () => ({ packet, model: { provider: 'main', model: 'chosen/model' }, maxInputTokens: 4096, maxOutputTokens: 512, timeoutMs: 1000 });
function response(value: unknown, usage?: CanonicalModelResponse['usage']): CanonicalModelResponse {
  return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }], finishReason: 'stop', usage };
}

test('Judge makes one bounded tool-free request and keeps real usage', async () => {
  const create = await factory();
  const calls: CanonicalModelRequest[] = [];
  const review = create({ modelRuntime: { complete: async (request: CanonicalModelRequest) => {
    calls.push(request);
    return response({ verdict: 'accepted', summary: 'Matches the task.', issues: [] }, { inputTokens: 130, outputTokens: 25 });
  } } });
  const result = await review(input());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'main');
  assert.equal(calls[0].model, 'chosen/model');
  assert.equal(calls[0].maxOutputTokens, 512);
  assert.deepEqual(calls[0].tools, []);
  assert.deepEqual(calls[0].thinking, { enabled: false });
  assert.equal(calls[0].messages.length, 1);
  assert.equal(JSON.stringify(calls[0]).includes('producerMessages'), false);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.usage, { inputTokens: 130, outputTokens: 25 });
});

test('Judge never calls model for an empty or incomplete packet', async () => {
  const create = await factory();
  let calls = 0;
  const review = create({ modelRuntime: { complete: async () => { calls++; throw new Error('unexpected call'); } } });
  assert.equal((await review({ ...input(), packet: { ...packet, hasContent: false } })).status, 'skipped');
  assert.equal((await review({ ...input(), packet: { ...packet, complete: false, warnings: ['Result was truncated.'] } })).status, 'inconclusive');
  assert.equal(calls, 0);
});

test('Judge rejects malformed and contradictory verdicts without inventing usage', async () => {
  const create = await factory();
  for (const value of [{}, { verdict: 'accepted', summary: 'Fine', issues: [{ path: '$', code: 'bad', message: 'Actually wrong' }] }, { verdict: 'rejected', summary: 'Wrong', issues: [] }]) {
    const result = await create({ modelRuntime: { complete: async () => response(value) } })(input());
    assert.equal(result.status, 'error');
    assert.equal(result.usage, undefined);
  }
});

test('Judge preserves a concrete rejected result and an inconclusive result', async () => {
  const create = await factory();
  const issue = { path: '$.result', code: 'requirement', message: 'The requested explanation is missing.' };
  const rejected = await create({ modelRuntime: { complete: async () => response({ verdict: 'rejected', summary: 'Incomplete answer.', issues: [issue] }) } })(input());
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.issues, [issue]);
  const inconclusive = await create({ modelRuntime: { complete: async () => response({ verdict: 'inconclusive', summary: 'Need the actual result.', issues: [] }) } })(input());
  assert.equal(inconclusive.status, 'inconclusive');
});

test('Judge timeout bounds even an uncooperative model promise', async () => {
  const create = await factory();
  const review = create({ modelRuntime: { complete: async () => new Promise<CanonicalModelResponse>(() => {}) } });
  const started = Date.now();
  const result = await review({ ...input(), timeoutMs: 15 });
  assert.equal(result.status, 'error');
  assert.equal(result.issues[0].code, 'review_timeout');
  assert.ok(Date.now() - started < 1000);
});

test('Judge respects cancellation and does not accept a length-limited response', async () => {
  const create = await factory();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const review = create({ modelRuntime: { complete: async () => { calls++; return response({ verdict: 'accepted', summary: 'ok', issues: [] }); } } });
  await assert.rejects(review({ ...input(), signal: controller.signal }), /abort/i);
  assert.equal(calls, 0);
  const incomplete = create({ modelRuntime: { complete: async () => ({ ...response({ verdict: 'accepted', summary: 'ok', issues: [] }), finishReason: 'length' }) } });
  assert.equal((await incomplete(input())).status, 'error');
});

test('An explicit accepted verdict may omit an empty issues list, but not its explanation', async () => {
  const create = await factory();
  const review = (value: unknown) => create({ modelRuntime: { complete: async () => response(value) } })(input());
  assert.equal((await review({ verdict: 'accepted', summary: 'The supplied result meets the task.' })).status, 'accepted');
  assert.equal((await review({ verdict: 'accepted' })).status, 'error');
  assert.equal((await review({ verdict: 'rejected', summary: 'Wrong.' })).status, 'error');
  assert.equal((await review({ verdict: 'accepted', summary: 'Fine', issues: 'none' })).status, 'error');
});
