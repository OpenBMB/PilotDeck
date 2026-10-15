import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { handlePublicHostHttpRequest } from '../../src/composition/publicHostHttpTransport.js';

test('PD model and parse transport accepts user principals without a StaffDeck employee', async t => {
  const calls: unknown[] = [];
  const server = createServer((req, res) => {
    void handlePublicHostHttpRequest(req, res, { token: 'service', resolve: principal => ({
      operations: ['list_model_catalog', 'file_parse'],
      async call(operation, input) { calls.push({ principal, operation, input }); return { status: 200, body: { ok: true } }; },
    }) });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No address');
  const url = `http://127.0.0.1:${address.port}/api/module-host/call`;
  const principal = { pilotDeckUserId: 'pd', tenantId: 'namespace', actorUserId: 'pd' };
  const request = (body: unknown) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer service', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const operation of ['list_model_catalog', 'file_parse']) {
    assert.equal((await request({ principal, operation, input: {} })).status, 200);
  }
  assert.equal(calls.length, 2);
  assert.equal((await request({ principal: { ...principal, agentId: '' }, operation: 'file_parse', input: {} })).status, 400);
  assert.equal((await request({ principal, operation: 'file_parse', input: { actorUserId: 'forged' } })).status, 400);
  assert.equal(calls.length, 2);
});
