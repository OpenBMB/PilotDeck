import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWLEDGE_CORE_METHODS, KNOWLEDGE_CORE_OPERATIONS, knowledgeCoreRequest, knowledgeCoreRestRequest } from '../../src/composition/knowledgeCoreOperations.mjs';
import type { ExternalModuleBinding } from '../../src/composition/types.js';

const binding = { endpoint: 'http://km', spaceId: 'a', spaces: [{ id: 'a' }, { id: 'b' }], methods: KNOWLEDGE_CORE_METHODS } as unknown as ExternalModuleBinding;
const input = { knowledge_base_id: 'kb', document_id: 'doc', bucket_id: 'bucket', chunk_id: 'chunk', job_id: 'job', suggestion_id: 'suggestion', concept_id: 'concept', id: 'a', space_id: 'b', source_space_id: 'a', expected_updated_at: '2026-10-14', query: 'policy', content_md: 'text' };
for (const name of KNOWLEDGE_CORE_METHODS) test('explicit KM operation: ' + name, () => {
  const request = knowledgeCoreRequest(name, input, binding);
  assert.equal(request.method, KNOWLEDGE_CORE_OPERATIONS[name].method);
  const proxy = knowledgeCoreRestRequest(request.method, request.url.pathname.replace('/api/km/v1', ''), input, binding);
  assert.equal(proxy.url.toString(), request.url.toString());
  assert.deepEqual(proxy.body, request.body);
  if (KNOWLEDGE_CORE_OPERATIONS[name].write) assert.throws(() => knowledgeCoreRequest(name, input, { ...binding, readOnly: true }), /read-only/);
  assert.throws(() => knowledgeCoreRequest(name, input, { ...binding, methods: [] }), /not declared/);
});
test('unknown operations, identity and scope overrides, missing edit versions are rejected', () => {
  assert.throws(() => knowledgeCoreRequest('unknown', {}, binding), /not declared/);
  assert.throws(() => knowledgeCoreRestRequest('POST', '/unknown', {}, binding), /Unknown/);
  assert.throws(() => knowledgeCoreRequest('query', { actor: 'admin' }, binding), /identity/);
  assert.throws(() => knowledgeCoreRequest('query', { space_id: 'other' }, binding), /permission/);
  assert.throws(() => knowledgeCoreRequest('bind_base', { ...input, source_space_id: 'other' }, binding), /permission/);
  assert.throws(() => knowledgeCoreRequest('create_space', { id: 'other' }, binding), /permission/);
  assert.throws(() => knowledgeCoreRequest('update_document', { document_id: 'doc' }, binding), /expected_updated_at/);
  assert.equal(knowledgeCoreRequest('query', { use_model: false }, binding).body?.use_model, false);
  assert.equal(knowledgeCoreRequest('upsert_okf_concept', { knowledge_base_id: 'kb', concept_id: 'new', content_md: 'New' }, binding).body?.expected_updated_at, undefined);
});
