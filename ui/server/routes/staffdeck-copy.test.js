import express from 'express';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createStaffDeckCopyRouter } from './staffdeck-copy.js';

const TOKEN_ENV = 'PILOTDECK_TEST_STAFFDECK_USER_TOKEN';
const methods = ['list_agents', 'list_knowledge_bases', 'list_skills', 'import_resources'];
const agents = [
  { id: 'employee-real', tenant_id: 'tenant-real', name: 'Employee', is_overall: false, status: 'active', metadata: { directory_access: { can_manage: true } } },
  { id: 'plaza-real', tenant_id: 'tenant-real', name: 'Plaza', is_overall: true, status: 'active' },
];

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function setup({ pilotDeckUserId = 'pd-user', upstreamStatus = 200, authStatus = 200,
  authUser = { id: 'sd-user', tenant_id: 'tenant-real', disabled: false }, pathStatuses = {}, redirectPath,
  enabled = true, moduleAgentId, directory = agents, bindingOverrides = {} } = {}) {
  const requests = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.use((req, res) => {
    requests.push({ path: req.originalUrl, method: req.method, authorization: req.headers.authorization, body: req.body });
    if (req.originalUrl === '/api/auth/me') {
      return authStatus === 200 ? res.json(authUser) : res.status(authStatus).json({ detail: 'Formal identity rejected' });
    }
    if (req.originalUrl === redirectPath) return res.redirect('https://elsewhere.example/credential-target');
    if (upstreamStatus !== 200) return res.status(upstreamStatus).json({ detail: 'Formal permission rejected' });
    if (pathStatuses[req.originalUrl]) return res.status(pathStatuses[req.originalUrl]).json({ detail: 'Formal resource permission rejected' });
    if (req.originalUrl === '/api/enterprise/agents?tenant_id=tenant-real') return res.json(directory);
    if (req.originalUrl === '/api/enterprise/knowledge-bases?tenant_id=tenant-real&agent_id=plaza-real') return res.json([{ id: 'base-real', status: 'active' }]);
    if (req.originalUrl === '/api/enterprise/agents/plaza-real/skills?tenant_id=tenant-real') return res.json([{ id: 'sop-real', status: 'published' }]);
    if (req.originalUrl === '/api/enterprise/agents/employee-real/resources/import') return res.json({ imported: [{ id: req.body.resource_ids[0] }], missing: [] });
    return res.status(404).json({ detail: 'Unexpected formal path' });
  });
  const upstreamServer = await listen(upstream);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: pilotDeckUserId }; next(); });
  app.use('/api/modules/staffdeck-copy', createStaffDeckCopyRouter({ loadConfig: () => ({ modules: moduleAgentId ? { sop: { management: { agentId: moduleAgentId } } } : {}, webui: { staffdeckCopy: {
    enabled, contract: 'staffdeck.enterprise-copy/v1', methods,
    endpoint: upstreamServer.origin, tenantId: 'tenant-real', actorUserId: 'sd-user', targetAgentId: 'employee-real',
    pilotDeckUserId: 'pd-user', userTokenEnv: TOKEN_ENV, ...bindingOverrides,
  } } }) }));
  const bridge = await listen(app);
  return { ...bridge, upstreamServer: upstreamServer.server, requests };
}

async function call(origin, operation, input) {
  const response = await fetch(`${origin}/api/modules/staffdeck-copy/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }),
  });
  return { status: response.status, body: await response.json() };
}

afterEach(() => { delete process.env[TOKEN_ENV]; });

describe('StaffDeck formal copy bridge', () => {
  it('reads only actual visible directory, source resources, and both formal import types', async () => {
    process.env[TOKEN_ENV] = 'actual-user-token';
    const fixture = await setup();
    try {
      const directory = await call(fixture.origin, 'list_agents');
      expect(directory).toEqual({ status: 200, body: { result: [
        { id: 'employee-real', tenant_id: 'tenant-real', name: 'Employee', is_overall: false, active: true, copy_target: true, can_manage: true },
        { id: 'plaza-real', tenant_id: 'tenant-real', name: 'Plaza', is_overall: true, active: true, copy_target: false, can_manage: false },
      ] } });
      expect((await call(fixture.origin, 'list_knowledge_bases', { sourceAgentId: 'plaza-real' })).body.result).toEqual([{ id: 'base-real', status: 'active' }]);
      expect((await call(fixture.origin, 'list_skills', { sourceAgentId: 'plaza-real' })).body.result).toEqual([{ id: 'sop-real', status: 'published' }]);
      for (const [resourceType, resourceId] of [['knowledge_base', 'base-real'], ['skill', 'sop-real']]) {
        expect((await call(fixture.origin, 'import_resources', {
          targetAgentId: 'employee-real', sourceAgentId: 'plaza-real', resourceType, resourceIds: [resourceId],
          tenantId: 'forged-tenant',
        })).body.result.imported).toEqual([{ id: resourceId }]);
      }
      expect(fixture.requests.every((request) => request.authorization === 'Bearer actual-user-token')).toBe(true);
      expect(fixture.requests.filter((request) => request.path === '/api/auth/me')).toHaveLength(5);
      for (let index = 0; index < fixture.requests.length; index += 1) {
        if (fixture.requests[index].path.startsWith('/api/enterprise/agents?')) {
          expect(fixture.requests[index - 1].path).toBe('/api/auth/me');
        }
      }
      expect(fixture.requests.filter((request) => request.method === 'POST').map((request) => request.body)).toEqual([
        { tenant_id: 'tenant-real', source_agent_id: 'plaza-real', resource_type: 'knowledge_base', resource_ids: ['base-real'] },
        { tenant_id: 'tenant-real', source_agent_id: 'plaza-real', resource_type: 'skill', resource_ids: ['sop-real'] },
      ]);
      expect(JSON.stringify(directory.body)).not.toContain('actual-user-token');
    } finally { await close(fixture.server); await close(fixture.upstreamServer); }
  });

  it('rejects forged user, target, source, and arbitrary operations before copy', async () => {
    process.env[TOKEN_ENV] = 'actual-user-token';
    const fixture = await setup();
    const otherUser = await setup({ pilotDeckUserId: 'other-pd-user' });
    try {
      expect((await call(fixture.origin, 'arbitrary_enterprise_path', { path: '/api/enterprise/agents' })).status).toBe(400);
      expect((await call(otherUser.origin, 'list_agents')).status).toBe(403);
      expect((await call(fixture.origin, 'list_skills', { sourceAgentId: 'hidden-agent' })).status).toBe(403);
      expect((await call(fixture.origin, 'import_resources', { targetAgentId: 'plaza-real', sourceAgentId: 'plaza-real', resourceType: 'skill', resourceIds: ['sop-real'] })).status).toBe(403);
      expect(fixture.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(otherUser.requests).toEqual([]);
    } finally { await close(fixture.server); await close(fixture.upstreamServer); await close(otherUser.server); await close(otherUser.upstreamServer); }
  });

  it('does not fabricate an overall source when the formal directory has none', async () => {
    process.env[TOKEN_ENV] = 'actual-user-token';
    const fixture = await setup({ directory: [agents[0]] });
    try {
      expect((await call(fixture.origin, 'list_agents')).body.result).toEqual([
        { id: 'employee-real', tenant_id: 'tenant-real', name: 'Employee', is_overall: false, active: true, copy_target: true, can_manage: true },
      ]);
      expect((await call(fixture.origin, 'list_skills', { sourceAgentId: 'plaza-real' })).status).toBe(403);
    } finally { await close(fixture.server); await close(fixture.upstreamServer); }
  });

  it('preserves formal permission failure and fails closed without credentials or configuration', async () => {
    process.env[TOKEN_ENV] = 'actual-user-token';
    const rejected = await setup({ upstreamStatus: 403 });
    const disabled = await setup({ enabled: false });
    const mismatch = await setup({ moduleAgentId: 'different-agent' });
    try {
      expect((await call(rejected.origin, 'list_agents')).status).toBe(403);
      // A disabled formal binding is a standalone deployment: the enabled
      // plugin serves its local directory instead of failing closed.
      expect(await call(disabled.origin, 'list_agents')).toEqual({ status: 200, body: { result: [{
        id: 'pd-user', tenant_id: 'local', name: '当前用户', is_overall: false, active: true, can_manage: true, copy_target: true,
      }] } });
      expect((await call(mismatch.origin, 'list_agents')).status).toBe(409);
      expect(mismatch.requests).toEqual([]);
      delete process.env[TOKEN_ENV];
      expect((await call(rejected.origin, 'list_agents')).status).toBe(501);
    } finally { await close(rejected.server); await close(rejected.upstreamServer); await close(disabled.server); await close(disabled.upstreamServer); await close(mismatch.server); await close(mismatch.upstreamServer); }
  });

  it('distinguishes missing user bindings from a configured PilotDeck user mismatch', async () => {
    process.env[TOKEN_ENV] = 'actual-user-token';
    const noPilotDeckUser = await setup({ bindingOverrides: { pilotDeckUserId: '' } });
    const noActor = await setup({ bindingOverrides: { actorUserId: '' } });
    const wrongPilotDeckUser = await setup({ pilotDeckUserId: 'other-pd-user' });
    try {
      for (const fixture of [noPilotDeckUser, noActor]) {
        const result = await call(fixture.origin, 'list_agents');
        expect(result).toEqual({ status: 501, body: { error: {
          code: 'COPY_IDENTITY_UNAVAILABLE', message: 'StaffDeck copy identity is not configured.',
        } } });
        expect(fixture.requests).toEqual([]);
      }
      const mismatch = await call(wrongPilotDeckUser.origin, 'list_agents');
      expect(mismatch.status).toBe(403);
      expect(mismatch.body.error.code).toBe('COPY_USER_FORBIDDEN');
      expect(wrongPilotDeckUser.requests).toEqual([]);
    } finally {
      for (const fixture of [noPilotDeckUser, noActor, wrongPilotDeckUser]) {
        await close(fixture.server);
        await close(fixture.upstreamServer);
      }
    }
  });

  it('rejects expired credentials and mismatched formal user or tenant before reading the directory', async () => {
    process.env[TOKEN_ENV] = 'actual-user-token';
    const expired = await setup({ authStatus: 401 });
    const wrongUser = await setup({ authUser: { id: 'another-user', tenant_id: 'tenant-real' } });
    const wrongTenant = await setup({ authUser: { id: 'sd-user', tenant_id: 'another-tenant' } });
    const disabled = await setup({ authUser: { id: 'sd-user', tenant_id: 'tenant-real', disabled: true } });
    try {
      for (const [fixture, status, code] of [
        [expired, 401, 'COPY_IDENTITY_REJECTED'],
        [wrongUser, 403, 'COPY_IDENTITY_MISMATCH'],
        [wrongTenant, 403, 'COPY_IDENTITY_MISMATCH'],
        [disabled, 403, 'COPY_IDENTITY_MISMATCH'],
      ]) {
        const result = await call(fixture.origin, 'list_agents');
        expect(result.status).toBe(status);
        expect(result.body.error.code).toBe(code);
        expect(fixture.requests.map((request) => request.path)).toEqual(['/api/auth/me']);
      }
    } finally {
      for (const fixture of [expired, wrongUser, wrongTenant, disabled]) {
        await close(fixture.server);
        await close(fixture.upstreamServer);
      }
    }
  });

  it('preserves formal source and target permission denials without claiming an import succeeded', async () => {
    process.env[TOKEN_ENV] = 'actual-user-token';
    const sourcePath = '/api/enterprise/knowledge-bases?tenant_id=tenant-real&agent_id=plaza-real';
    const importPath = '/api/enterprise/agents/employee-real/resources/import';
    const sourceDenied = await setup({ pathStatuses: { [sourcePath]: 403 } });
    const targetDenied = await setup({ pathStatuses: { [importPath]: 403 } });
    try {
      expect((await call(sourceDenied.origin, 'list_knowledge_bases', { sourceAgentId: 'plaza-real' })).status).toBe(403);
      expect(sourceDenied.requests.some((request) => request.method === 'POST')).toBe(false);
      const result = await call(targetDenied.origin, 'import_resources', {
        targetAgentId: 'employee-real', sourceAgentId: 'plaza-real', resourceType: 'knowledge_base', resourceIds: ['base-real'],
      });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('COPY_UPSTREAM_REJECTED');
      expect(targetDenied.requests.at(-1).path).toBe(importPath);
    } finally {
      for (const fixture of [sourceDenied, targetDenied]) {
        await close(fixture.server);
        await close(fixture.upstreamServer);
      }
    }
  });

  it('does not follow an upstream redirect with the configured user credential', async () => {
    process.env[TOKEN_ENV] = 'actual-user-token';
    const fixture = await setup({ redirectPath: '/api/enterprise/agents?tenant_id=tenant-real' });
    try {
      const result = await call(fixture.origin, 'list_agents');
      expect(result.status).toBe(502);
      expect(result.body.error.code).toBe('COPY_UPSTREAM_UNAVAILABLE');
      expect(fixture.requests.map((request) => request.path)).toEqual([
        '/api/auth/me', '/api/enterprise/agents?tenant_id=tenant-real',
      ]);
    } finally { await close(fixture.server); await close(fixture.upstreamServer); }
  });

  it('does not write when the PilotDeck module administrator is disabled', async () => {
    process.env[TOKEN_ENV] = 'actual-user-token';
    const previous = process.env.PILOTDECK_MODULE_ADMIN;
    process.env.PILOTDECK_MODULE_ADMIN = '0';
    const fixture = await setup();
    try {
      expect((await call(fixture.origin, 'import_resources', {
        targetAgentId: 'employee-real', sourceAgentId: 'plaza-real', resourceType: 'skill', resourceIds: ['sop-real'],
      })).status).toBe(403);
      expect(fixture.requests.every((request) => request.method === 'GET')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PILOTDECK_MODULE_ADMIN;
      else process.env.PILOTDECK_MODULE_ADMIN = previous;
      await close(fixture.server);
      await close(fixture.upstreamServer);
    }
  });
});
