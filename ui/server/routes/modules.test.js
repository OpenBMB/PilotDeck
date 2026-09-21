import express from 'express';
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createModuleRuntimeRouter } from './modules.js';

describe('module runtime route', () => {
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

  it('applies the saved Knowledge defaults to a real module query', async () => {
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
      expect(response.status).toBe(200);
      expect(received.payload.input).toMatchObject({ query: 'handbook', baseId: 'published-base', knowledgeBaseIds: ['published-base'], tenantId: 'tenant-demo', actorUserId: 'operator', limit: 7 });
    } finally {
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => moduleServer.close(resolve));
    }
  });
});
