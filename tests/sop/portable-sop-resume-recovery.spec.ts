import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortableSopRuntimeClient } from '../../src/sop/staffdeck/PortableSopRuntimeClient.js';
import { SopStateStore } from '../../src/sop/staffdeck/SopStateStore.js';

for (const status of [409, 422, 408, 503, 0]) {
  test(`resume recovery distinguishes Runtime rejection (${status}) from uncertain delivery`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sop-resume-recovery-'));
    let attempts = 0;
    const state = { session_id: 'session', sop_id: 'sop', sop_version: '1', active_node_id: 'wait',
      slots: {}, pending_wait: { kind: 'external_task', wait_id: 'wait', node_id: 'wait' },
      status: 'waiting_external_task', revision: 1, metadata: {} };
    const runtime = new PortableSopRuntimeClient('http://runtime', { fetch: async (_url, options) => {
      if (options?.method === 'GET') return Response.json({ ok: true, state,
        definition: { sop_id: 'sop', version: '1', content: { nodes: [{ node_id: 'wait' }] } } });
      attempts++;
      if (attempts === 1) {
        if (!status) throw new Error('Connection reset');
        return Response.json({ protocolVersion: '3.0', requestId: 'original', ok: false,
          error: { code: status === 409 ? 'SOP_REQUEST_CONFLICT' : 'SOP_RUNTIME_REJECTED', message: 'Rejected' } }, { status });
      }
      const request = JSON.parse(String(options?.body));
      return Response.json({ protocolVersion: '3.0', requestId: request.requestId, ok: true,
        payload: { state: { ...state, pending_wait: null, status: 'active', revision: 2 } } });
    } });
    try {
      let store = new SopStateStore(root, runtime);
      const input = { sessionId: 'session', waitId: 'wait', requestId: 'original',
        expectedRevision: 1, source: 'external_task' as const, message: 'Finished' };
      await assert.rejects(store.resume(input));
      store = new SopStateStore(root, runtime);
      const corrected = { ...input, requestId: 'corrected', message: 'Corrected' };
      if (status >= 400 && status < 500 && status !== 408) {
        assert.equal((await store.resume(corrected)).accepted, true);
      } else {
        await assert.rejects(store.resume(corrected), { code: 'SOP_RESUME_REQUEST_CONFLICT' });
        assert.equal((await store.resume(input)).accepted, true);
      }
      assert.equal(attempts, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
