// @vitest-environment node
import express from 'express';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createKnowledgeCoreRouter } from './knowledge-core.js';

describe('independent knowledge gateway', () => {
  it('uses configured credentials, declarations and spaces while retaining model selection', async () => {
    const received = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'local-user' }; next(); });
    app.use('/km', createKnowledgeCoreRouter({
      loadConfig: () => ({ modules: { knowledge: { enabled: true, contract: 'knowledge-core/v1',
        endpoint: 'http://knowledge', bearer: 'server-token', pilotDeckUserId: 'local-user',
        spaceId: 'space-a', methods: ['query', 'list_bases', 'list_spaces', 'bind_base'],
        spaces: [{ id: 'space-a', name: 'Employee' }],
      } } }),
      fetchImpl: async (url, options) => {
        if (String(url).endsWith('/api/km/config')) return Response.json({ api_protocol: 'knowledge-core/v1', modules: { spaces: true, catalog: true, versions: true }, operations: {
          query: { method: 'POST', path: '/api/km/v1/query' }, list_bases: { method: 'GET', path: '/api/km/v1/knowledge-bases' },
          list_spaces: { method: 'GET', path: '/api/km/v1/spaces' }, bind_base: { method: 'POST', path: '/api/km/v1/knowledge-bases/{knowledge_base_id}/bindings' },
        } });
        received.push({ url: String(url), options });
        return Response.json(String(url).endsWith('/spaces') ? [{ id: 'space-a', name: 'Core' }, { id: 'other' }] : { chunks: [] });
      },
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}/km`;
    try {
      const response = await fetch(origin + '/query', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ space_id: 'space-a', query: 'receipts', use_model: true, model_id: 'pd/model' }),
      });
      expect(response.status).toBe(200);
      expect(received[0].options.headers.authorization).toBe('Bearer server-token');
      expect(JSON.parse(received[0].options.body)).toEqual({ space_id: 'space-a', query: 'receipts', use_model: true, model_id: 'pd/model', max_chunks: 6 });
      const rejected = await fetch(origin + '/knowledge-bases?space_id=other');
      expect(rejected.status).toBe(403);
      expect(received).toHaveLength(1);
      expect((await fetch(origin + '/knowledge-bases?space_id=space-a')).status).toBe(200);
      expect(received[1].options.body).toBeUndefined();
      const bind = await fetch(origin + '/knowledge-bases/kb/bindings?source_space_id=other', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ space_id: 'space-a' }),
      });
      expect(bind.status).toBe(403);
      expect(await (await fetch(origin + '/spaces')).json()).toEqual([{ id: 'space-a', name: 'Employee', can_write: false }]);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
