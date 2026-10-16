import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStaffDeckPublishRoute } from './staffdeck-publish-route.js';

const owner = { tenantId: 'tenant', actorUserId: 'actor', agentId: 'agent', credentialId: 'owned' };
const definition = version => ({ id: 'row-' + version, skill_id: 'selected', name: 'Test', version, status: 'published', content: { skill_id: 'selected', version, nodes: [{ node_id: 'n', extension: { preserved: true } }], edges: [] } });
test('archive removes only the requested runtime definition after owner success', async t => {
  const f = await fixture(t), calls = [];
  const route = createStaffDeckPublishRoute({ getGateway: async () => ({ reloadExtensions: async input => { calls.push(input); return { reloaded: true }; } }) });
  await route.publish({ ...f, owner, sopId: 'selected', publish: async () => ({ status: 200, body: { sop: definition('2') } }) });
  assert.equal((await route.read({ ...f, owner })).receipts.length, 1);
  calls.length = 0;
  const failure = await route.archive({ ...f, owner, sopId: 'selected', archive: async () => ({ status: 403, body: {} }) });
  assert.equal(failure.status, 403);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).sops.length, 1);
  const archived = await route.archive({ ...f, owner, sopId: 'selected', archive: async () => ({ status: 200, body: { skill_id: 'selected', status: 'archived' } }) });
  assert.equal(archived.runtime.refreshRequested, true);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).sops.length, 0);
  assert.deepEqual((await route.read({ ...f, owner })).receipts, []);
  assert.deepEqual(calls, [{ changedPaths: [f.path] }]);
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'definitions.yaml');
  await writeFile(path, JSON.stringify({ sops: [{ ...definition('1'), id: 'selected' }] }));
  return { path, binding: { enabled: true, definitionsPath: path, defaultSopId: 'selected', discoveryAgentId: 'agent', discoveryEndpoint: 'http://owner/api/v1' },
    management: { agentId: 'agent', endpoint: 'http://owner/api/v1/' } };
}

test('normal publish uses the existing Gateway port and receipts survive a new web instance', async t => {
  const f = await fixture(t);
  const calls = [];
  const route = createStaffDeckPublishRoute({ getGateway: async () => ({ reloadExtensions: async input => { calls.push(input); return { reloaded: true }; } }) });
  let published = 0;
  const response = { status: 200, body: { sop: definition('2'), draft: { id: 'draft', etag: 'original' } } };
  const result = await route.publish({ ...f, owner, sopId: 'selected', publish: async () => { published++; return response; } });
  assert.equal(published, 1);
  assert.equal(result.body, response.body);
  assert.deepEqual(calls, [{ changedPaths: [f.path] }]);
  assert.equal(result.runtime.effective, false);
  assert.equal(result.runtime.receiptPersisted, true);
  assert.equal(result.runtime.status, 'awaiting-runtime-observation');
  const restarted = createStaffDeckPublishRoute({ getGateway: () => assert.fail('reading receipt must not refresh') });
  assert.deepEqual((await restarted.read({ ...f, owner })).receipts, [{ sopId: 'selected', ...result.runtime }]);
  assert.deepEqual((await restarted.read({ ...f, owner: { ...owner, credentialId: 'other' } })).receipts, []);
  const bundle = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(bundle.sops[0].id, 'selected');
  assert.equal(bundle.sops[0].content.nodes[0].extension.preserved, true);
});

test('Gateway failure stays a persisted runtime failure without changing owner publication', async t => {
  const f = await fixture(t);
  const route = createStaffDeckPublishRoute({ getGateway: async () => { throw Object.assign(new Error('private endpoint and credential detail'), { code: 'GATEWAY_UNAVAILABLE' }); } });
  const response = { status: 200, body: { sop: definition('2') } };
  const result = await route.publish({ ...f, owner, sopId: 'selected', publish: async () => response });
  assert.equal(result.body, response.body);
  assert.equal(result.status, 200);
  assert.equal(result.runtime.ownerPublished, true);
  assert.equal(result.runtime.receiptPersisted, true);
  assert.deepEqual(result.runtime.failure, { phase: 'refresh', code: 'GATEWAY_UNAVAILABLE' });
  assert.equal('runtimeError' in result, false);
  assert.equal(JSON.stringify(result).includes('private endpoint'), false);
  assert.equal((await route.read({ ...f, owner })).receipts[0].effective, false);
});

test('receipt write failure preserves publication and refuses to claim persistence', async t => {
  const f = await fixture(t);
  const route = createStaffDeckPublishRoute({ getGateway: async () => ({ reloadExtensions: async () => ({ reloaded: true }) }),
    receiptStore: { read: async () => ({ receipts: {} }), write: async () => { throw new Error('disk full'); } } });
  const response = { status: 200, body: { sop: definition('2') } };
  const result = await route.publish({ ...f, owner, sopId: 'selected', publish: async () => response });
  assert.equal(result.body, response.body);
  assert.equal(result.runtime.effective, false);
  assert.equal(result.runtime.receiptPersisted, false);
  assert.deepEqual(result.runtime.receiptFailure, { code: 'SOP_RUNTIME_RECEIPT_FAILED' });
});
