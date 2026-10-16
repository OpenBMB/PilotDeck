import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicApprovalBridge, type PublicApprovalSessionResolver } from '../../src/composition/publicApprovalBridge.js';
import { SopStateStore } from '../../src/sop/staffdeck/SopStateStore.js';
import { startGatewayServer } from '../../src/gateway/server/GatewayServer.js';
import { GatewayWsClient } from '../../src/gateway/client/GatewayWsClient.js';
import type { Gateway } from '../../src/gateway/protocol/types.js';

const binding = { tenantId: 'tenant', agentId: 'target', pilotDeckUserId: 'pd-owner' };
const subject = { tenantId: 'tenant', userId: 'approver', source: 'web' as const, role: 'member' as const, disabled: false };
const resolveSession: PublicApprovalSessionResolver = async input => input.sessionKey === 'session'
  ? { ...binding, sessionKey: 'session', projectKey: '/fixture-project' } : undefined;

async function fixture(run: (f: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>, resolver: PublicApprovalSessionResolver | null = resolveSession) {
  const f = await makeFixture(resolver ?? undefined);
  try { await run(f); } finally { await f.server.close(); await rm(f.root, { recursive: true, force: true }); }
}
async function makeFixture(resolver: PublicApprovalSessionResolver | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'approval-bridge-'));
  const store = new SopStateStore(root);
  const bundle = { sops: [{ id: 'sop', version: 'pinned-old', content: { nodes: [{ node_id: 'approval', assignee_user_id: 'approver' }] } }] };
  await store.loadOrCreate('session', bundle, 'sop');
  await store.replace('session', bundle, { status: 'handoff', active_skill_id: 'sop', active_step_id: 'approval' });
  let authentications = 0;
  const bridge = createPublicApprovalBridge({ binding, resolveSession: resolver,
    authenticate: async ({ bearer }) => {
      authentications++;
      if (bearer === 'fixture-forbidden') throw Object.assign(new Error('Rejected'), { status: 403, code: 'APPROVAL_AUTH_REJECTED' });
      if (bearer !== 'fixture-approver') throw Object.assign(new Error('Rejected'), { status: 401, code: 'APPROVAL_AUTH_REJECTED' });
      return subject;
    },
    status: input => store.status(input.sessionKey),
    resume: input => store.resume({ ...input, sessionId: input.sessionKey }),
  });
  const gateway = { describeServer: async () => ({ mode: 'in_process' }), sopStatus: bridge.status,
    resumeSop: bridge.resume } as unknown as Gateway;
  const server = await startGatewayServer({ gateway, publicApprovals: bridge, port: 0, token: 'fixture-service' });
  const snapshot = (await store.status('session'))!;
  const command = { sessionKey: 'session', source: 'human' as const, requestId: 'request', waitId: snapshot.wait!.id,
    expectedRevision: snapshot.revision, message: 'Reviewed' };
  const call = (operation: string, body: object, headers: Record<string, string> = {}) => fetch(`${server.url}/api/module-host/approvals/${operation}`, {
    method: 'POST', headers: { authorization: 'Bearer fixture-service', 'x-staffdeck-approver-authorization': 'Bearer fixture-approver',
      'content-type': 'application/json', ...headers }, body: JSON.stringify({ tenantId: binding.tenantId, agentId: binding.agentId, ...body }),
  });
  return { root, store, bridge, server, command, call, authentications: () => authentications };
}

test('actual Gateway HTTP bridge preserves pinned projection and reauthenticates cleared-wait replay', () => fixture(async f => {
  const status = await f.call('status', { sessionKey: 'session' });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).status.approval.version, 'pinned-old');
  const first = await f.call('resume', f.command); assert.equal(first.status, 200);
  const receipt = await first.json(); assert.equal(receipt.duplicate, false);
  assert.equal((await f.store.status('session'))!.wait, undefined);
  const replay = await f.call('resume', f.command); assert.equal(replay.status, 200);
  const repeated = await replay.json(); assert.equal(repeated.duplicate, true); assert.equal(repeated.revision, receipt.revision);
  assert.equal(f.authentications(), 3);
  assert.ok(!JSON.stringify(repeated).includes('fixture-approver'));
}));

test('original receipt conflict keeps its HTTP code and leaves the receipt unchanged', () => fixture(async f => {
  const first = await f.call('resume', f.command);
  assert.equal(first.status, 200);
  const receipt = await first.json();
  for (const changed of [
    { ...f.command, message: 'Different approval' },
    { ...f.command, expectedRevision: f.command.expectedRevision + 1 },
  ]) {
    const response = await f.call('resume', changed);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: 'SOP_RESUME_REQUEST_CONFLICT' });
  }
  const replay = await f.call('resume', f.command);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ...receipt, duplicate: true });
  assert.equal((await f.store.status('session'))!.revision, receipt.revision);
}));

test('service auth, forged authority, wrong scope and missing approver cannot reach the wait', () => fixture(async f => {
  assert.equal((await f.call('resume', f.command, { authorization: 'Bearer wrong-service' })).status, 401);
  assert.equal((await f.call('resume', { ...f.command, authority: { subject: { role: 'admin' } } })).status, 400);
  assert.equal((await f.call('resume', { ...f.command, tenantId: 'foreign' })).status, 403);
  assert.equal((await f.call('resume', f.command, { 'x-staffdeck-approver-authorization': '' })).status, 401);
  assert.equal(f.authentications(), 0);
  assert.equal((await f.store.status('session'))!.wait!.id, f.command.waitId);
}));

test('uninstalled authoritative session resolver returns the precise source gap without resuming', () => fixture(async f => {
  const response = await f.call('resume', f.command);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'SOP_APPROVAL_SESSION_MAPPING_UNAVAILABLE');
  assert.equal((await f.store.status('session'))!.wait!.id, f.command.waitId);
}, null));

test('existing sop_resume RPC cannot supply authority or omit authentication and uses the same receipt', () => fixture(async f => {
  const client = new GatewayWsClient({ url: f.server.wsUrl, token: 'fixture-service' });
  await client.connect();
  try {
    await assert.rejects(client.request('sop_resume', f.command), (error: { code?: string }) => error.code === 'APPROVAL_AUTH_REQUIRED');
    await assert.rejects(client.request('sop_resume', { ...f.command, authority: { tenantId: 'tenant', subject } }),
      (error: { code?: string }) => error.code === 'APPROVAL_AUTHORITY_OVERRIDE');
    await assert.rejects(client.request('sop_resume', { ...f.command, approverAuthorization: 'Bearer fixture-forbidden' }),
      (error: { code?: string; details?: { httpStatus?: number } }) => error.code === 'APPROVAL_AUTH_REJECTED' && error.details?.httpStatus === 403);
    const input = { ...f.command, approverAuthorization: 'bearer fixture-approver' };
    const receipt = await client.request('sop_resume', input) as { duplicate: boolean; revision: number };
    const replay = await client.request('sop_resume', input) as { duplicate: boolean; revision: number };
    assert.equal(receipt.duplicate, false); assert.equal(replay.duplicate, true); assert.equal(replay.revision, receipt.revision);
  } finally { client.close(); }
}));

test('foreign authoritative session/project tuple is rejected before status or resume', () => fixture(async f => {
  const response = await f.call('status', { sessionKey: 'session', projectKey: '/caller-project' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'SOP_APPROVAL_SESSION_FORBIDDEN');
  assert.equal((await f.store.status('session'))!.wait!.id, f.command.waitId);
}));

test('project approval HTTP resolves the admitted agent and rejects another project identity', async () => {
  const admitted = { ...binding, agentId: 'project-a', sessionKey: 'session-a', projectKey: '/a' };
  let lookups = 0;
  const bridge = createPublicApprovalBridge({ binding: { ...binding, agentId: '' },
    resolveBinding: async () => admitted,
    resolveSession: async () => admitted,
    authenticate: async () => subject,
    status: async () => { lookups++; return undefined; },
    resume: async () => { throw new Error('Not expected'); },
  });
  const server = await startGatewayServer({ gateway: {} as Gateway, publicApprovals: bridge, port: 0, token: 'service' });
  try {
    const call = (agentId: string, projectKey = '/a') => fetch(`${server.url}/api/module-host/approvals/status`, {
      method: 'POST', headers: { authorization: 'Bearer service', 'x-staffdeck-approver-authorization': 'Bearer actor',
        'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant', agentId, projectKey, sessionKey: 'session-a' }),
    });
    assert.equal((await call('project-a')).status, 200);
    assert.equal((await call('project-b')).status, 403);
    assert.equal((await call('project-a', '/b')).status, 403);
    assert.equal(lookups, 1);
  } finally { await server.close(); }
});
