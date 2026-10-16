import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createKnowledgeModulePort } from '../../src/composition/domainPorts.js';
import { parseModulesConfig } from '../../src/pilot/config/parseModulesConfig.js';
import type { PilotConfigDiagnostic } from '../../src/pilot/config/types.js';
import { knowledgeCoreRequest, knowledgeCoreRestRequest } from '../../src/composition/knowledgeCoreOperations.mjs';
import type { ExternalModuleBinding } from '../../src/composition/types.js';

test('catalog upload body belongs to the advertised route and partial contexts survive proxy dispatch', () => {
  const binding = { endpoint: 'http://km', spaceId: 'a', spaces: [{ id: 'a' }],
    methods: ['import_document', 'list_documents', 'update_document', 'copy_version', 'upsert_concept'] } as unknown as ExternalModuleBinding;
  const full = { api_protocol: 'knowledge-core/v1', modules: { spaces: true, catalog: true, versions: true }, operations: {
    import_document: { method: 'POST', path: '/api/km/v1/knowledge-bases/{knowledge_base_id}/documents' },
  } };
  const uploaded = knowledgeCoreRequest('import_document', { knowledge_base_id: 'base', filename: 'test.md', content_base64: 'eA==' }, binding, full);
  assert.equal(uploaded.body?.knowledge_base_id, undefined);
  const camelCase = knowledgeCoreRequest('import_document', { knowledgeBaseId: 'base', filename: 'test.md', contentBase64: 'eA==' }, binding, full);
  assert.equal(camelCase.url.pathname, uploaded.url.pathname);
  assert.deepEqual(camelCase.body, uploaded.body);
  const partial = { api_protocol: 'knowledge-core/v1', modules: { spaces: true, catalog: true, versions: true }, operations: {
    import_document: { method: 'POST', path: '/api/km/v1/documents' },
    list_documents: { method: 'GET', path: '/api/km/v1/documents' },
    update_document: { method: 'PUT', path: '/api/km/v1/documents/{document_id}' },
    get_branch: { method: 'GET', path: '/api/km/v1/knowledge-bases/{knowledge_base_id}/branch' },
    copy_version: { method: 'POST', path: '/api/km/v1/knowledge-bases/{knowledge_base_id}/versions/copy' },
    upsert_concept: { method: 'PUT', path: '/api/km/v1/concepts/{concept_id:path}' },
  } };
  const request = knowledgeCoreRequest('import_document', { knowledge_base_id: 'base', filename: 'test.md', content_base64: 'eA==' }, binding, partial);
  assert.equal(request.body?.knowledge_base_id, 'base');
  const list = knowledgeCoreRestRequest('GET', '/documents', { knowledge_base_id: 'base', version_id: 'snapshot' }, binding, partial);
  assert.equal(list.url.searchParams.get('knowledge_base_id'), 'base');
  assert.equal(list.url.searchParams.get('version_id'), 'snapshot');
  assert.throws(() => knowledgeCoreRequest('copy_version', { knowledge_base_id: 'base' }, binding, partial), /expected_updated_at/);
  const copy = knowledgeCoreRequest('copy_version', { knowledge_base_id: 'base', expected_updated_at: 'revision', version_id: 'snapshot' }, binding, partial);
  assert.equal(copy.url.searchParams.get('version_id'), null);
  assert.equal(copy.body?.version_id, 'snapshot');
  const concept = knowledgeCoreRestRequest('PUT', '/concepts/sources/expense', { document_id: 'doc', content_md: 'text', expected_updated_at: 'revision' }, binding, partial);
  assert.equal(concept.operation, 'upsert_concept');
  assert.equal(concept.body?.document_id, 'doc');
});

test('minimal capability negotiation uses instance scope and refuses disabled methods and parameters', async t => {
  const calls: unknown[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/km/config') {
      res.end(JSON.stringify({ api_protocol: 'knowledge-core/v1', modules: { spaces: false, catalog: false, versions: false },
        operations: { query: { method: 'POST', path: '/api/km/v1/query' }, list_documents: { method: 'GET', path: '/api/km/v1/documents' } } })); return;
    }
    const body: Buffer[] = []; for await (const part of req) body.push(Buffer.from(part));
    calls.push({ path: req.url, body: body.length ? JSON.parse(Buffer.concat(body).toString()) : undefined });
    res.end(JSON.stringify(req.method === 'GET' ? [] : { chunks: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing port');
  const diagnostics: PilotConfigDiagnostic[] = [];
  const modules = parseModulesConfig({ knowledge: { enabled: true, implementationId: 'knowledge-core',
    contract: 'knowledge-core/v1', transport: 'rest-http-v1', endpoint: `http://127.0.0.1:${address.port}`,
    pilotDeckUserId: 'operator', methods: ['query', 'list_documents', 'list_versions'],
  } }, '/tmp', diagnostics);
  assert.deepEqual(diagnostics, []);
  const binding = modules?.knowledge; if (!binding || !('endpoint' in binding)) throw Error('Missing binding');
  const port = createKnowledgeModulePort(binding);
  assert.deepEqual(await port.call('query', { query: 'receipts', use_model: false }), { chunks: [] });
  assert.deepEqual(await port.call('list_documents', {}), []);
  await assert.rejects(port.call('query', { query: 'receipts', space_id: 'forged' }), /Space module is disabled/);
  await assert.rejects(port.call('query', { query: 'receipts', knowledge_base_ids: [] }), /catalog module is disabled/);
  await assert.rejects(port.call('list_versions', { knowledge_base_id: 'missing' }), /catalog module is disabled/);
  assert.deepEqual(calls, [{ path: '/api/km/v1/query', body: { query: 'receipts', use_model: false, max_chunks: 6 } }, { path: '/api/km/v1/documents', body: undefined }]);
});
