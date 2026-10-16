// @vitest-environment node
import express from 'express';
import http from 'node:http';
import { expect, it } from 'vitest';
import { createKnowledgeCapabilitiesRouter } from './knowledge-capabilities.js';

it('uses the bound PD principal, model ports and remote stream with service authorization', async () => {
  process.env.KM_TEST_CAPABILITIES = 'service-secret';
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/capabilities', createKnowledgeCapabilitiesRouter({ internal: true,
    loadConfig: req => ({ modules: { knowledge: { enabled: Boolean(req?.headers.authorization), contract: 'knowledge-core/v1',
      capabilitiesCredentialEnv: 'KM_TEST_CAPABILITIES', pilotDeckUserId: 'pd-user', namespace: 'pd',
      spaceId: 'a', spaces: [{ id: 'a' }] } } }),
    getGateway: async () => ({}),
    getHostCapabilities: async () => ({ operations: ['list_model_catalog', 'model_prepare', 'model_stream', 'file_parse'],
      async call(operation, input, options) {
        calls.push({ operation, input, principal: options.principal });
        if (operation === 'list_model_catalog') return { status: 200, body: { data: [{ id: 'provider/model', is_default: true }] } };
        if (operation === 'file_parse') return { status: 200, body: { text: 'content', metadata: { fileType: 'md' } } };
        if (operation === 'model_prepare') return { status: 200, body: { request: input.request, selection: { providerId: 'provider', selectedModelId: 'model' } } };
        return { status: 200, body: (async function* () {
          const encoded = JSON.stringify({ type: 'text_delta', text: '{"valid":true}' }) + '\n' + JSON.stringify({ type: 'message_end' }) + '\n';
          yield Buffer.from(encoded.slice(0, 13)); yield Buffer.from(encoded.slice(13));
        })() };
      },
    }),
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/capabilities`;
  const request = (operation, body, token = 'service-secret') => fetch(url + '/' + operation, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ tenant_id: 'pd', space_id: 'a', ...body }),
  });
  try {
    expect((await request('model', {}, 'wrong')).status).toBe(401);
    expect((await request('model', { space_id: 'other' })).status).toBe(403);
    expect(calls).toHaveLength(0);
    const response = await request('model', { prompt: 'Return JSON', actor: 'forged' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true });
    expect(calls.every(row => row.principal.actorUserId === 'pd-user' && row.principal.tenantId === 'pd')).toBe(true);
    const stream = calls.find(row => row.operation === 'model_stream');
    expect(stream.input.requestId).toBeTruthy();
    expect(stream.input.modelId).toBe('provider/model');
    expect(await (await request('parse', { filename: 'file.md', content_base64: 'YQ==' })).json()).toEqual({ text: 'content', file_type: 'md' });
    expect(calls.at(-1).input.content_base64).toBe('YQ==');
  } finally {
    delete process.env.KM_TEST_CAPABILITIES;
    await new Promise(resolve => server.close(resolve));
  }
});
