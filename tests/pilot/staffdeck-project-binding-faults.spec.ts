import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureProjectBinding, refreshProjectBinding, projectBindingSummary, projectForStaffDeckPrincipal } from '../../src/pilot/staffdeck/projectBinding.js';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'binding-fault-'));
  const key = 'sd_live_binding_fault_key';
  const env = { PILOT_HOME: home, STAFFDECK_PROJECT_BINDING_ENABLED: 'true',
    STAFFDECK_FORMAL_API_ORIGIN: 'http://sd.test', STAFFDECK_COPY_TENANT_ID: 'tenant',
    STAFFDECK_COPY_ACTOR_USER_ID: 'actor', STAFFDECK_COPY_PILOTDECK_USER_ID: 'owner',
    STAFFDECK_COPY_USER_TOKEN: 'token', STAFFDECK_SOP_MANAGEMENT_API_KEY: key,
    STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID: 'credential', STAFFDECK_SOP_RUNTIME_ORIGIN: 'http://sop.test' };
  const targets = new Map<string, string>();
  let calls = 0, status = 200, mismatch = false, missingScope = false;
  const request = (async (url: URL, options: RequestInit) => {
    calls++;
    if (status !== 200) return Response.json({ error: 'upstream' }, { status });
    if (url.pathname === '/api/auth/me') return Response.json({ id: mismatch ? 'other' : 'actor', tenant_id: 'tenant' });
    if (url.pathname.endsWith('/api-credentials')) return Response.json([{ id: 'credential', user_id: 'actor',
      status: 'active', access: 'user_full_access', key_prefix: key.slice(0, 20),
      scopes: missingScope ? [] : ['agents:read', 'agents:write', 'knowledge:read', 'knowledge:write', 'sops:read', 'sops:write', 'sops:publish'] }]);
    if (url.pathname.endsWith('agents:ensure-project-binding')) {
      const body = JSON.parse(String(options.body));
      if (!targets.has(body.project_binding_id)) targets.set(body.project_binding_id, `agent-${targets.size}`);
      return Response.json({ ...body, agent: { id: targets.get(body.project_binding_id) } });
    }
    return Response.json({ id: url.pathname.split('/').at(-1), name: 'Agent', is_overall: false, status: 'active' });
  }) as typeof fetch;
  return { home, env, request, targets, root: join(home, 'a'), get calls() { return calls; },
    set status(value: number) { status = value; }, set mismatch(value: boolean) { mismatch = value; },
    set missingScope(value: boolean) { missingScope = value; }, dispose: () => rm(home, { recursive: true, force: true }) };
}

test('B06 status cache revalidates at 30 seconds without provisioning', async () => {
  const f = await fixture(), original = Date.now; let now = original();
  Date.now = () => now;
  try {
    assert.equal((await ensureProjectBinding(f.root, f)).status, 'bound');
    await refreshProjectBinding(f.root, f);
    const count = f.calls;
    now += 29999;
    await refreshProjectBinding(f.root, f);
    assert.equal(f.calls, count);
    now++;
    f.status = 401;
    assert.equal((await refreshProjectBinding(f.root, f)).status, 'failed');
    assert.equal(f.targets.size, 1);
    await refreshProjectBinding(f.root, f);
    assert.equal(f.calls, count + 1);
  } finally { Date.now = original; await f.dispose(); }
});

test('B05 rejected credentials and identity conflicts preserve the original target', async () => {
  const f = await fixture();
  try {
    const first = await ensureProjectBinding(f.root, f);
    for (const status of [401, 403, 500, 503]) {
      f.status = status;
      const failed = await ensureProjectBinding(f.root, f);
      assert.equal(failed.status, 'failed');
      assert.equal('agentId' in failed && failed.agentId, 'agentId' in first && first.agentId);
      assert.equal(f.targets.size, 1);
    }
    f.status = 200; f.mismatch = true;
    assert.equal((await ensureProjectBinding(f.root, f)).status, 'failed');
    f.mismatch = false; f.missingScope = true;
    assert.equal((await ensureProjectBinding(f.root, f)).status, 'failed');
    f.missingScope = false;
    assert.equal((await ensureProjectBinding(f.root, { ...f, env: { ...f.env, STAFFDECK_COPY_TENANT_ID: 'other' } })).status, 'failed');
    assert.equal((await ensureProjectBinding(f.root, f)).status, 'bound');
    assert.equal(f.targets.size, 1);
  } finally { await f.dispose(); }
});

test('B05 missing or invalid configuration does not send upstream requests', async () => {
  const f = await fixture();
  try {
    for (const change of [{ STAFFDECK_COPY_USER_TOKEN: '' }, { STAFFDECK_FORMAL_API_ORIGIN: 'file:///tmp' }]) {
      const result = await ensureProjectBinding(f.root, { ...f, env: { ...f.env, ...change } });
      assert.equal(result.status, 'failed');
    }
    assert.equal(f.calls, 0);
    assert.equal((await ensureProjectBinding(f.root, f)).status, 'bound');
  } finally { await f.dispose(); }
});

test('B03 stale locks recover and damaged storage never resets installation identity', async () => {
  const f = await fixture(), path = join(f.home, 'staffdeck/project-bindings.json');
  try {
    await mkdir(join(f.home, 'staffdeck'));
    await writeFile(path + '.lock', '2147483647');
    assert.equal((await ensureProjectBinding(f.root, f)).status, 'bound');
    const valid = await readFile(path, 'utf8');
    await writeFile(path, '{broken');
    const result = await ensureProjectBinding(f.root, f);
    assert.equal(result.status, 'failed');
    assert.equal(await readFile(path, 'utf8'), '{broken');
    assert.equal(f.targets.size, 1);
    await writeFile(path, valid);
    assert.equal((await ensureProjectBinding(f.root, f)).status, 'bound');
  } finally { await f.dispose(); }
});

test('I04 rejects all callback identity mismatches and ambiguous mappings', async () => {
  const f = await fixture();
  try {
    await ensureProjectBinding(f.root, f);
    const summary = projectBindingSummary(f.root, f.env);
    const principal = { tenantId: 'tenant', actorUserId: 'actor', pilotDeckUserId: 'owner', agentId: 'agentId' in summary ? summary.agentId : '' };
    for (const key of ['tenantId', 'actorUserId', 'pilotDeckUserId', 'agentId']) {
      assert.throws(() => projectForStaffDeckPrincipal({ ...principal, [key]: 'foreign' }, f.env));
    }
    const path = join(f.home, 'staffdeck/project-bindings.json');
    const store = JSON.parse(await readFile(path, 'utf8'));
    store.projects.push({ ...store.projects[0], projectRoot: join(f.home, 'duplicate') });
    await writeFile(path, JSON.stringify(store));
    assert.throws(() => projectForStaffDeckPrincipal(principal, f.env));
  } finally { await f.dispose(); }
});

test('B03 live lock timeout and unavailable storage never provision or replace persisted state', async () => {
  const f = await fixture(), path = join(f.home, 'staffdeck/project-bindings.json');
  try {
    await ensureProjectBinding(f.root, f);
    const original = await readFile(path, 'utf8');
    await writeFile(path + '.lock', String(process.pid));
    const busy = await ensureProjectBinding(f.root, f);
    assert.equal(busy.status, 'failed');
    assert.equal('error' in busy && busy.error?.code, 'PROJECT_BINDING_BUSY');
    assert.equal(await readFile(path, 'utf8'), original);
    await rm(path + '.lock');
    await mkdir(path + '.lock');
    const unavailable = await ensureProjectBinding(f.root, f);
    assert.equal(unavailable.status, 'failed');
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(f.targets.size, 1);
  } finally { await f.dispose(); }
});

test('B03 unwritable storage preserves installation identity and never sends upstream requests', async t => {
  if (process.getuid?.() === 0) return t.skip('Root bypasses directory write permissions');
  const f = await fixture(), directory = join(f.home, 'staffdeck');
  try {
    await ensureProjectBinding(f.root, f);
    const path = join(directory, 'project-bindings.json'), original = await readFile(path, 'utf8');
    const calls = f.calls;
    await chmod(directory, 0o500);
    const failed = await ensureProjectBinding(f.root, f);
    assert.equal(failed.status, 'failed');
    assert.equal('error' in failed && failed.error?.code, 'EACCES');
    assert.equal(f.calls, calls);
    assert.equal(await readFile(path, 'utf8'), original);
    await chmod(directory, 0o700);
    assert.equal((await ensureProjectBinding(f.root, f)).status, 'bound');
    assert.equal(f.targets.size, 1);
  } finally { await chmod(directory, 0o700).catch(() => {}); await f.dispose(); }
});
