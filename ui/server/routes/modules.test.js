import express from 'express';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createModuleRuntimeRouter } from './modules.js';

describe('module runtime route', () => {
  it('negotiates instance-scoped KM queries, citations and management calls', async () => {
    const calls = [];
    let scoped = false;
    const upstream = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/km/config') {
        res.end(JSON.stringify({ api_protocol: 'knowledge-core/v1', modules: { spaces: scoped, catalog: false, versions: false }, operations: {
          query: { method: 'POST', path: '/api/km/v1/query' },
          resolve_citation: { method: 'GET', path: '/api/km/v1/citations/{chunk_id}' },
          list_documents: { method: 'GET', path: '/api/km/v1/documents' },
          list_spaces: { method: 'GET', path: '/api/km/v1/spaces' },
        } }));
        return;
      }
      let raw = ''; for await (const part of req) raw += part;
      calls.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.end(JSON.stringify(req.url === '/api/km/v1/documents' ? []
        : req.url === '/api/km/v1/spaces' ? [{ id: 'allowed' }, { id: 'other' }] : { chunks: [] }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'operator' }; next(); });
    app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => ({ modules: { knowledge: {
      enabled: true, contract: 'knowledge-core/v1', endpoint: `http://127.0.0.1:${upstream.address().port}`,
      pilotDeckUserId: 'operator', methods: ['query', 'resolve_citation', 'list_documents', 'list_spaces'],
      ...(scoped ? { spaceId: 'allowed', spaces: [{ id: 'allowed' }] } : {}),
    } } }) }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/api/modules/knowledge/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      expect((await post('query', { query: 'receipts', use_model: false })).status).toBe(200);
      expect((await post('citation', { chunkId: 'chunk' })).status).toBe(200);
      expect(await (await post('call', { operation: 'list_documents', input: {} })).json()).toEqual({ result: [] });
      expect(calls).toEqual([
        { url: '/api/km/v1/query', body: { query: 'receipts', use_model: false, max_chunks: 6 } },
        { url: '/api/km/v1/citations/chunk', body: undefined },
        { url: '/api/km/v1/documents', body: undefined },
      ]);
      scoped = true;
      expect(await (await post('call', { operation: 'list_spaces', input: {} })).json()).toEqual({ result: [{ id: 'allowed' }] });
    } finally {
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => upstream.close(resolve));
    }
  });

  it('returns sanitized module bindings and gateway capabilities', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({
      loadConfig: () => ({ modules: {
        agentLoop: { enabled: true, provider: 'pilotdeck', secret: 'must-not-leak' },
        knowledge: { enabled: true, implementationId: 'staffdeck.knowledge', contract: 'staffdeck.knowledge/v1', transport: 'module-http-v2', endpoint: 'http://private', methods: ['query'] },
      } }),
      getGateway: vi.fn(async () => ({ describeServer: async () => ({ capabilities: ['set_permission_mode'] }) })),
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/runtime`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.modules.knowledge).toMatchObject({ enabled: true, implementationId: 'staffdeck.knowledge', methods: ['query'] });
      expect(body.modules.knowledge.endpoint).toBeUndefined();
      expect(body.modules.agentLoop.secret).toBeUndefined();
      expect(body.gatewayCapabilities).toEqual(['set_permission_mode']);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('returns module bindings when the chat gateway is unavailable', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({
      loadConfig: () => ({ modules: {
        sop: { enabled: true, implementationId: 'staffdeck.portable-sop', contract: 'sop.lifecycle/v2' },
      } }),
      getGateway: vi.fn(async () => { throw new Error('Gateway is starting'); }),
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/runtime`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        modules: { sop: { enabled: true, implementationId: 'staffdeck.portable-sop' } },
        gatewayCapabilities: [],
        runtime: { gatewayState: 'unavailable', unavailableSlots: [] },
      });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('rejects a query when the configured capability is absent', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => ({ modules: { knowledge: { enabled: true, endpoint: 'http://127.0.0.1:1', methods: [] } } }) }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/knowledge/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'handbook' }) });
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.error.code).toBe('MODULE_CAPABILITY_UNAVAILABLE');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('rejects citation resolution when the configured capability is absent', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => ({ modules: { knowledge: { enabled: true, endpoint: 'http://127.0.0.1:1', methods: ['query'] } } }) }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/knowledge/citation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chunkId: 'chunk-1' }) });
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.error.code).toBe('MODULE_CAPABILITY_UNAVAILABLE');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('rejects a legacy Knowledge query without the formal identity binding', async () => {
    let received;
    const moduleApp = express();
    moduleApp.use(express.json());
    moduleApp.post('/v2/module/call', (req, res) => {
      received = req.body;
      res.json({ kind: 'response', inReplyTo: req.body.messageId, ok: true, payload: { result: { chunks: [] } } });
    });
    const moduleServer = http.createServer(moduleApp);
    await new Promise(resolve => moduleServer.listen(0, '127.0.0.1', resolve));
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => ({ modules: { knowledge: {
      enabled: true,
      endpoint: `http://127.0.0.1:${moduleServer.address().port}`,
      methods: ['query'],
      defaultBaseId: 'published-base',
      tenantId: 'tenant-demo',
      actorUserId: 'operator',
      resultLimit: 7,
    } } }) }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/knowledge/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'handbook' }) });
      expect(response.status).toBe(501);
      expect((await response.json()).error.code).toBe('COPY_UNAVAILABLE');
      expect(received).toBeUndefined();
    } finally {
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => moduleServer.close(resolve));
    }
  });
  it('does not lend legacy Knowledge identity to an unbound browser submitting forged owner values', async () => {
    let received;
    const moduleApp = express();
    moduleApp.use(express.json());
    moduleApp.post('/v2/module/call', (req, res) => {
      received = req.body;
      res.json({ kind: 'response', inReplyTo: req.body.messageId, ok: true, payload: { result: { chunks: [] } } });
    });
    const moduleServer = http.createServer(moduleApp);
    await new Promise(resolve => moduleServer.listen(0, '127.0.0.1', resolve));
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => ({ modules: { knowledge: {
      enabled: true,
      endpoint: `http://127.0.0.1:${moduleServer.address().port}`,
      methods: ['query'],
      tenantId: 'tenant-bound',
      actorUserId: 'owner-bound',
    } } }) }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/knowledge/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'handbook', tenantId: 'tenant-forged', tenant_id: 'tenant-forged-snake', actorUserId: 'user-forged', actor_user_id: 'user-forged-snake' }),
      });
      expect(response.status).toBe(501);
      expect((await response.json()).error.code).toBe('COPY_UNAVAILABLE');
      expect(received).toBeUndefined();
    } finally {
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => moduleServer.close(resolve));
    }
  });
  it.each([
    'create_base', 'update_base', 'delete_base', 'sync_base', 'publish_version', 'rollback_version',
    'import_document', 'import_okf', 'update_document', 'delete_document', 'update_bucket',
    'update_chunk', 'cancel_job', 'upsert_okf_concept', 'lint_okf', 'confirm_discovery', 'reject_discovery',
  ])('rejects Knowledge write %s when the single-user module administrator is disabled', async (operation) => {
    const previous = process.env.PILOTDECK_MODULE_ADMIN;
    process.env.PILOTDECK_MODULE_ADMIN = '0';
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => ({ modules: { knowledge: {
      enabled: true, endpoint: 'http://127.0.0.1:1', methods: [operation], tenantId: 'tenant-bound', actorUserId: 'owner-bound',
    } } }) }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/knowledge/call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation, input: { name: 'forbidden' } }),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('MODULE_ADMIN_REQUIRED');
    } finally {
      if (previous === undefined) delete process.env.PILOTDECK_MODULE_ADMIN;
      else process.env.PILOTDECK_MODULE_ADMIN = previous;
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('rejects legacy Knowledge management when formal owner binding is absent', async () => {
    let received;
    const moduleApp = express();
    moduleApp.use(express.json());
    moduleApp.post('/v2/module/call', (req, res) => {
      received = req.body;
      res.json({ kind: 'response', inReplyTo: req.body.messageId, ok: true, payload: { result: [{ id: 'kb-1', name: 'Handbook' }] } });
    });
    const moduleServer = http.createServer(moduleApp);
    await new Promise(resolve => moduleServer.listen(0, '127.0.0.1', resolve));
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => ({ modules: { knowledge: {
      enabled: true,
      endpoint: `http://127.0.0.1:${moduleServer.address().port}`,
      methods: ['list_bases'],
      tenantId: 'tenant-demo',
      actorUserId: 'operator',
    } } }) }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/knowledge/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'list_bases', input: {} }) });
      expect(response.status).toBe(501);
      expect((await response.json()).error.code).toBe('COPY_UNAVAILABLE');
      expect(received).toBeUndefined();
    } finally {
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => moduleServer.close(resolve));
    }
  });
  it('reads and saves deployment-owned SOP definitions without exposing the runtime endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilotdeck-sop-definitions-'));
    const definitionsPath = join(root, 'definitions.yaml');
    await writeFile(definitionsPath, 'sops:\n  - id: approval\n    name: Operator approval\n    content:\n      nodes:\n        - node_id: handoff\n          type: handoff\n');
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({
      loadConfig: () => ({ modules: { sop: { enabled: true, definitionsPath, defaultSopId: 'approval', endpoint: 'http://private-runtime' } } }),
      getGateway: vi.fn(async () => ({ describeServer: async () => ({ capabilities: ['sop_status'] }) })),
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const listed = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/sop/definitions`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ defaultSopId: 'approval', definitions: [{ id: 'approval', name: 'Operator approval' }] });
      const saved = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/sop/definitions/approval`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definition: { id: 'approval', name: 'Updated approval', content: { nodes: [{ node_id: 'handoff', type: 'handoff' }] } } }) });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ definition: { id: 'approval', name: 'Updated approval' }, restartRequired: true });
      expect(await readFile(definitionsPath, 'utf8')).toContain('Updated approval');
      const runtime = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/runtime`);
      expect(await runtime.json()).toMatchObject({
        runtime: { gatewayState: 'ready', unavailableSlots: ['sop'] },
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an exact page-published SOP object as a local definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilotdeck-sop-published-'));
    const definitionsPath = join(root, 'published.json');
    await writeFile(definitionsPath, JSON.stringify({
      id: 'project_delivery_plan',
      skill_id: 'project_delivery_plan',
      version: '1.2.0',
      content: { skill_id: 'project_delivery_plan', nodes: [{ node_id: 'n1_collect', type: 'collect_info' }] },
    }));
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({
      loadConfig: () => ({ modules: { sop: { enabled: true, definitionsPath, defaultSopId: 'project_delivery_plan' } } }),
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const listed = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/sop/definitions`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ defaultSopId: 'project_delivery_plan', definitions: [{ id: 'project_delivery_plan', version: '1.2.0' }] });
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 501 only when public SOP management is not configured', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/modules', createModuleRuntimeRouter({
      loadConfig: () => ({ modules: { sop: { enabled: true, definitionsPath: '/tmp/unused.yaml' } } }),
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules/sop/management/call`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'list' }),
      });
      expect(response.status).toBe(501);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('binds SOP management to the formal account credential and fixed owner', async () => {
    const key = 'sdak_account_key_for_test_123456789';
    const previousKey = process.env.TEST_SOP_ACCOUNT_KEY;
    const previousToken = process.env.TEST_COPY_LOGIN_TOKEN;
    process.env.TEST_SOP_ACCOUNT_KEY = key;
    process.env.TEST_COPY_LOGIN_TOKEN = 'user-login-token';
    const received = [];
    const state = { pilotUserId: '1', actorId: 'actor-1', tenantId: 'tenant-1', loginActive: true, credentialId: 'credential-1', credentialPrefix: key.slice(0, 20), credentialStatus: 'active', expiresAt: null, scopes: ['sops:read', 'sops:write', 'sops:publish'], upstreamStatus: 200 };
    const managementApp = express();
    managementApp.use(express.json());
    managementApp.get('/api/auth/me', (req, res) => {
      received.push('me');
      if (req.headers.authorization !== 'Bearer user-login-token' || !state.loginActive) return res.sendStatus(401);
      return res.json({ id: state.actorId, tenant_id: state.tenantId });
    });
    managementApp.get('/api/auth/me/api-credentials', (_req, res) => {
      received.push('credentials');
      return res.json([{ id: state.credentialId, user_id: state.actorId, key_prefix: `${state.credentialPrefix}…`, access: 'user_full_access', status: state.credentialStatus, expires_at: state.expiresAt, scopes: state.scopes }]);
    });
    managementApp.get('/api/v1/agents/agent-1/sops', (req, res) => {
      received.push('list');
      if (req.headers.authorization !== `Bearer ${key}`) return res.sendStatus(401);
      return res.status(state.upstreamStatus).json(state.upstreamStatus === 200 ? { data: [{ skill_id: 'review' }] } : { error: { code: 'UPSTREAM_DOWN', message: 'temporarily unavailable' } });
    });
    managementApp.put('/api/v1/agents/agent-1/sops/review', (req, res) => {
      received.push({ etag: req.headers['if-match'], body: req.body });
      res.setHeader('ETag', 'etag-next');
      return res.json({ id: 'draft-1' });
    });
    managementApp.post('/api/v1/agents/agent-1/sops', (req, res) => {
      received.push({ createBody: req.body });
      return res.status(201).json({ id: 'first-draft' });
    });
    const managementServer = http.createServer(managementApp);
    await new Promise(resolve => managementServer.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${managementServer.address().port}`;
    const config = { webui: { staffdeckCopy: { enabled: true, contract: 'staffdeck.enterprise-copy/v1', endpoint: origin, tenantId: 'tenant-1', actorUserId: 'actor-1', targetAgentId: 'agent-1', pilotDeckUserId: '1', userTokenEnv: 'TEST_COPY_LOGIN_TOKEN' } }, modules: { sop: { enabled: true, management: { enabled: true, endpoint: `${origin}/api/v1`, apiKeyEnv: 'TEST_SOP_ACCOUNT_KEY', credentialId: 'credential-1', agentId: 'agent-1', methods: ['list', 'replace_draft', 'create'] } } } };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: state.pilotUserId }; next(); });
    app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => config }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const call = (operation, input) => fetch(`http://127.0.0.1:${server.address().port}/api/modules/sop/management/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }) });
    try {
      expect((await call('list')).status).toBe(200);
      expect(received).toEqual(['me', 'credentials', 'list']);
      const saved = await call('replace_draft', { sopId: 'review', draftId: 'draft-1', etag: 'etag-current', content: { skill_id: 'review' } });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ result: { id: 'draft-1', etag: 'etag-next' } });
      expect(received.at(-1)).toEqual({ etag: 'etag-current', body: { content: { skill_id: 'review' } } });
      expect((await call('create', { sopId: 'review', baseVersion: '2.3.4', content: { skill_id: 'review', version: '99.0.0' } })).status).toBe(201);
      expect(received.at(-1)).toMatchObject({ createBody: { base_version: '2.3.4', content: { version: '99.0.0' } } });
      expect((await call('publish')).status).toBe(409);

      config.webui.staffdeckCopy.enabled = false;
      received.length = 0;
      expect((await call('list')).status).toBe(501);
      expect(received).toEqual([]);
      config.webui.staffdeckCopy.enabled = true;

      state.pilotUserId = '2';
      received.length = 0;
      expect((await call('list')).status).toBe(403);
      expect(received).toEqual([]);
      state.pilotUserId = '1';
      config.modules.sop.management.agentId = 'agent-other';
      expect((await call('list')).status).toBe(409);
      expect(received).toEqual([]);
      config.modules.sop.management.agentId = 'agent-1';
      state.actorId = 'actor-other';
      expect((await call('list')).status).toBe(403);
      expect(received).toEqual(['me']);
      state.actorId = 'actor-1';
      received.length = 0;
      state.tenantId = 'tenant-other';
      expect((await call('list')).status).toBe(403);
      expect(received).toEqual(['me']);
      state.tenantId = 'tenant-1';
      received.length = 0;
      state.loginActive = false;
      expect((await call('list')).status).toBe(401);
      expect(received).toEqual(['me']);
      state.loginActive = true;
      received.length = 0;
      state.credentialId = 'other-credential';
      expect((await call('list')).status).toBe(403);
      expect(received).toEqual(['me', 'credentials']);
      state.credentialId = 'credential-1';
      state.credentialPrefix = 'sdak_other_credential';
      expect((await call('list')).status).toBe(403);
      state.credentialPrefix = key.slice(0, 20);
      state.credentialStatus = 'revoked';
      expect((await call('list')).status).toBe(401);
      state.credentialStatus = 'active';
      state.expiresAt = '2000-01-01T00:00:00Z';
      expect((await call('list')).status).toBe(401);
      state.expiresAt = null;
      state.scopes = ['sops:read'];
      expect((await call('list')).status).toBe(403);
      state.scopes = ['sops:read', 'sops:write', 'sops:publish'];
      state.upstreamStatus = 503;
      const failed = await call('list');
      expect(failed.status).toBe(503);
      expect((await failed.json()).error.code).toBe('UPSTREAM_DOWN');
    } finally {
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => managementServer.close(resolve));
      if (previousKey === undefined) delete process.env.TEST_SOP_ACCOUNT_KEY; else process.env.TEST_SOP_ACCOUNT_KEY = previousKey;
      if (previousToken === undefined) delete process.env.TEST_COPY_LOGIN_TOKEN; else process.env.TEST_COPY_LOGIN_TOKEN = previousToken;
    }
  });
});
