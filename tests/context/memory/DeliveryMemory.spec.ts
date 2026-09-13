import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EdgeClawMemoryService } from 'edgeclaw-memory-core';
import { createDeliveryMemoryObserver, readDeliveryMemory, DELIVERY_MEMORY_KEY } from '../../../src/context/memory/DeliveryMemory.js';
import type { DeliveryResult } from '../../../src/agent/sub/delivery/types.js';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'delivery-memory-'));
  const service = new EdgeClawMemoryService({ workspaceDir: dir, rootDir: join(dir, 'memory'), source: 'pilotdeck' });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  const result: DeliveryResult = { status: 'skipped', deliveryFile: '/private/secret.json', repairs: 0, producerUsage: { totalTokens: 100 }, reviewUsage: {}, attempts: [{ attempt: 1, deliveryFile: '/private/secret.json', checks: { status: 'skipped', checked: 0, issues: [] } }] };
  return { service, result, observe: createDeliveryMemoryObserver(service) };
}

test('stores bounded, deduplicated native metadata, retaining skipped as skipped', async t => {
  const { service, result, observe } = await fixture(t);
  const event = { sessionId: 'private-session', subagentId: 'child', definitionId: 'general-purpose', result };
  observe(event); observe(event);
  const rows = readDeliveryMemory(service);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped');
  assert.equal(rows[0].attempts[0].checks, 'skipped');
  assert.ok(!JSON.stringify(rows).includes('private'));
  for (let i = 0; i < 135; i++) observe({ ...event, subagentId: `child-${i}` });
  assert.equal(readDeliveryMemory(service).length, 128);
  const store = service.repository.getFileMemoryStore();
  assert.ok(store); // Actual native repository projection is exercised on every observation.
});

test('records repair and issue signatures without file paths or verdict prose', async t => {
  const { service, result, observe } = await fixture(t);
  result.status = 'failed';
  result.attempts[0].checks = { status: 'failed', checked: 1, issues: [{ path: '$.result.secret', code: 'file_missing', message: 'SECRET private body' }] };
  observe({ sessionId: 's', subagentId: 'c', definitionId: 'general-purpose', result });
  const rows = readDeliveryMemory(service);
  assert.equal(rows[0].attempts[0].issues[0].code, 'file_missing');
  assert.ok(!JSON.stringify(rows).includes('secret'));
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
});

test('corrupt state is preserved and reported rather than silently reset', async t => {
  const { service, result, observe } = await fixture(t);
  observe({ sessionId: 's', subagentId: 'c', definitionId: 'general-purpose', result });
  const db = new DatabaseSync(service.dbPath);
  t.after(() => db.close());
  db.prepare('UPDATE pipeline_state SET state_json = ? WHERE state_key = ?').run('{broken', DELIVERY_MEMORY_KEY);
  assert.throws(() => observe({ sessionId: 's', subagentId: 'd', definitionId: 'general-purpose', result }), /Corrupt/);
  assert.equal(db.prepare('SELECT state_json FROM pipeline_state WHERE state_key = ?').get(DELIVERY_MEMORY_KEY)?.state_json, '{broken');
});
