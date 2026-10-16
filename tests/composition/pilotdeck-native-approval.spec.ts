import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicApprovalBridge } from '../../src/composition/publicApprovalBridge.js';
import { SopStateStore } from '../../src/sop/staffdeck/SopStateStore.js';

test('native owner approval preserves wait and revision scope and rejects forged authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-owner-'));
  try {
    const store = new SopStateStore(root);
    const bundle = { sops: [{ id: 'sop', version: '1', content: { nodes: [{ node_id: 'approval', assignee_user_id: 'pilotdeck:owner' }] } }] };
    await store.loadOrCreate('session', bundle, 'sop');
    await store.replace('session', bundle, { status: 'handoff', active_skill_id: 'sop', active_step_id: 'approval' });
    const binding = { tenantId: 'pilotdeck', agentId: 'runtime-sop', pilotDeckUserId: 'owner' };
    let userId = 'owner';
    const bridge = createPublicApprovalBridge({ hostAdapter: 'pilotdeck', binding,
      authenticate: async () => ({ tenantId: 'pilotdeck', userId, role: 'admin', source: 'web', disabled: false }),
      resolveSession: async input => input.sessionKey === 'session' && input.projectKey === '/project'
        ? { ...binding, sessionKey: 'session', projectKey: '/project' } : undefined,
      status: input => store.status(input.sessionKey), resume: input => store.resume({ ...input, sessionId: input.sessionKey }),
    });
    const scope = { sessionKey: 'session', projectKey: '/project', approverAuthorization: 'Bearer owner-token' };
    const snapshot = await bridge.status(scope);
    assert.equal(snapshot?.approval?.assigneeUserId, 'pilotdeck:owner');
    const input = { ...scope, source: 'human' as const, waitId: snapshot!.wait!.id, requestId: 'request', expectedRevision: snapshot!.revision, message: 'Approved' };
    for (const invalid of [{ ...input, waitId: 'forged' }, { ...input, expectedRevision: 0 }, { ...input, projectKey: '/foreign' }, { ...input, authority: { subject: { userId: 'owner' } } }]) {
      await assert.rejects(bridge.resume(invalid));
    }
    userId = 'other'; await assert.rejects(bridge.resume(input), { code: 'APPROVAL_SUBJECT_MISMATCH' }); userId = 'owner';
    const first = await bridge.resume(input); const repeated = await bridge.resume(input);
    assert.equal(first.duplicate, false); assert.equal(repeated.duplicate, true); assert.equal(first.revision, repeated.revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});
