import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProjectBinding, ensureProjectBinding, projectBindingSummary, projectForStaffDeckPrincipal, refreshProjectBinding } from '../../src/pilot/staffdeck/projectBinding.js';

test('project bindings recover creation, isolate targets, and defer SOP execution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pd-binding-'));
  const env = { PILOT_HOME: home, STAFFDECK_PROJECT_BINDING_ENABLED: 'true',
    STAFFDECK_FORMAL_API_ORIGIN: 'http://sd.test', STAFFDECK_COPY_TENANT_ID: 'tenant',
    STAFFDECK_COPY_ACTOR_USER_ID: 'actor', STAFFDECK_COPY_PILOTDECK_USER_ID: 'owner',
    STAFFDECK_COPY_USER_TOKEN: 'user-token', STAFFDECK_SOP_MANAGEMENT_API_KEY: 'sd_live_test_credential_key',
    STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID: 'credential', STAFFDECK_SOP_RUNTIME_ORIGIN: 'http://sop.test' };
  const agents = new Map<string, string>();
  let lostResponse = true;
  let archived = false;
  let credentialRevoked = false;
  const request = (async (url: URL, options: RequestInit) => {
    const path = url.pathname;
    if (path === '/api/auth/me') return Response.json({ id: 'actor', tenant_id: 'tenant' });
    if (path === '/api/auth/me/api-credentials') return Response.json([{ id: 'credential', user_id: 'actor', status: credentialRevoked ? 'revoked' : 'active',
      access: 'user_full_access', key_prefix: env.STAFFDECK_SOP_MANAGEMENT_API_KEY.slice(0, 20) + '…',
      scopes: ['agents:read', 'agents:write', 'knowledge:read', 'knowledge:write', 'sops:read', 'sops:write', 'sops:publish'] }]);
    if (path === '/api/v1/agents:ensure-project-binding') {
      const body = JSON.parse(String(options.body));
      assert.equal(body.source_mode, 'blank');
      if (!agents.has(body.project_binding_id)) agents.set(body.project_binding_id, `agent-${agents.size}`);
      if (lostResponse) { lostResponse = false; throw new Error('response lost after SD committed'); }
      return Response.json({ ...body, agent: { id: agents.get(body.project_binding_id) } });
    }
    return Response.json({ id: path.split('/').at(-1), name: 'Project agent', is_overall: false, status: archived ? 'archived' : 'active' });
  }) as typeof fetch;
  try {
    const a = join(home, 'a'), b = join(home, 'b');
    assert.equal((await ensureProjectBinding(a, { env, request })).status, 'failed');
    await Promise.all([ensureProjectBinding(a, { env, request }), ensureProjectBinding(a, { env, request })]);
    await ensureProjectBinding(b, { env, request });
    assert.equal(agents.size, 2);
    const ca = applyProjectBinding({}, a, env), cb = applyProjectBinding({}, b, env);
    assert.equal(ca.modules.sop.timeoutMs, 30000);
    assert.equal(ca.modules.sop.discoveryTimeoutMs, 90000);
    const independent = applyProjectBinding({ modules: { sop: { timeoutMs: 120000 } } }, a, env);
    assert.equal(independent.modules.sop.timeoutMs, 120000);
    assert.equal(independent.modules.sop.discoveryTimeoutMs, 90000);
    const configured = applyProjectBinding({ modules: { sop: { timeoutMs: 120000, discoveryTimeoutMs: 45000 } } }, a, env);
    assert.equal(configured.modules.sop.timeoutMs, 120000);
    assert.equal(configured.modules.sop.discoveryTimeoutMs, 45000);
    assert.notEqual(ca.modules.knowledge.agentId, cb.modules.knowledge.agentId);
    assert.notEqual(ca.modules.sop.definitionsPath, cb.modules.sop.definitionsPath);
    assert.equal(applyProjectBinding({}, a, env, true).modules.sop.enabled, false);
    await writeFile(ca.modules.sop.definitionsPath, JSON.stringify({ sops: [{ id: 'published-a' }] }));
    const runtimeConfig = applyProjectBinding({ modules: { sop: { timeoutMs: 120000, discoveryTimeoutMs: 90000 } } }, a, env, true);
    assert.equal(runtimeConfig.modules.sop.timeoutMs, 120000);
    assert.equal(runtimeConfig.modules.sop.discoveryTimeoutMs, 90000);
    assert.equal(applyProjectBinding({ modules: { sop: { timeoutMs: -1, discoveryTimeoutMs: '90000' } } }, a, env).modules.sop.timeoutMs, 30000);
    assert.equal(applyProjectBinding({}, a, env, true).modules.sop.defaultSopId, 'published-a');
    assert.equal(applyProjectBinding({}, a, env, true).modules.sop.discoveryTimeoutMs, 90000);
    assert.equal(applyProjectBinding({}, a, env, true).modules.sop.timeoutMs, 30000);
    assert.equal(applyProjectBinding({}, b, env, true).modules.sop.enabled, false);
    assert.equal(projectForStaffDeckPrincipal({ tenantId: 'tenant', actorUserId: 'actor', pilotDeckUserId: 'owner', agentId: ca.modules.knowledge.agentId }, env), a);
    assert.throws(() => projectForStaffDeckPrincipal({ tenantId: 'tenant', actorUserId: 'actor', pilotDeckUserId: 'owner', agentId: 'unknown' }, env));
    assert.throws(() => projectForStaffDeckPrincipal({ tenantId: 'other', actorUserId: 'actor', pilotDeckUserId: 'owner', agentId: ca.modules.knowledge.agentId }, env));
    const raw = await readFile(join(home, 'staffdeck/project-bindings.json'), 'utf8');
    assert.equal(raw.includes('user-token'), false);
    assert.equal(raw.includes('api-key'), false);
    assert.equal((await ensureProjectBinding(join(home, 'again'), { env, request, explicitAgentId: ca.modules.knowledge.agentId })).status, 'failed');
    const reused = await ensureProjectBinding(join(home, 'legacy'), { env, request, explicitAgentId: 'existing-agent' });
    assert.equal(reused.status, 'bound');
    assert.equal('agentId' in reused && reused.agentId, 'existing-agent');
    assert.equal(agents.size, 2);
    await writeFile(join(home, 'pilotdeck.yaml'), 'agent: {model: test/model}\nmodel:\n  providers:\n    test:\n      protocol: openai\n      url: http://example.test/v1\n      apiKey: test\n      models: {model: {}}\n');
    let activated = false;
    assert.equal((await ensureProjectBinding(a, { env, request, activate: async () => {
      activated = true;
      assert.equal(projectBindingSummary(a, env).status, 'binding');
      assert.equal(applyProjectBinding({}, a, env, true).modules.knowledge.agentId, ca.modules.knowledge.agentId);
    } })).status, 'bound');
    assert.equal(activated, true);
    const activation = await ensureProjectBinding(a, { env, request, activate: async () => { throw new Error('Gateway unavailable'); } });
    assert.equal(activation.status, 'failed');
    assert.equal('agentId' in activation && activation.agentId, ca.modules.knowledge.agentId);
    assert.equal(applyProjectBinding({}, a, env).modules.knowledge.enabled, false);
    assert.equal((await ensureProjectBinding(a, { env, request })).status, 'bound');
    credentialRevoked = true;
    assert.equal((await ensureProjectBinding(a, { env, request })).status, 'failed');
    assert.equal(agents.size, 2);
    credentialRevoked = false;
    assert.equal((await ensureProjectBinding(a, { env, request })).status, 'bound');
    archived = true;
    assert.equal((await refreshProjectBinding(a, { env, request })).status, 'failed');
    assert.equal((await ensureProjectBinding(a, { env, request })).status, 'failed');
    assert.equal(agents.size, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('disabled integration preserves fixed profiles', async () => {
  assert.deepEqual(applyProjectBinding({ modules: { sop: { agentId: 'fixed' } } }, '/a', {}), { modules: { sop: { agentId: 'fixed' } } });
  assert.equal((await ensureProjectBinding('/a', { env: {} })).status, 'disabled');
});
