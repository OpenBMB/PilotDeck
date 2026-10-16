import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createKnowledgeAgentTools } from '../../src/composition/knowledgeAgentTools.js';
import type { ExternalModuleBinding } from '../../src/composition/types.js';
import type { PilotDeckToolRuntimeContext } from '../../src/tool/index.js';
import { parseModulesConfig } from '../../src/pilot/config/parseModulesConfig.js';
import type { PilotConfigDiagnostic } from '../../src/pilot/config/types.js';
const context = {} as PilotDeckToolRuntimeContext;

test('Agent tools default to query and never acquire management from runtime methods', async () => {
  const binding = { contract: 'knowledge-core/v1', methods: ['query', 'delete_document'], endpoint: 'http://unused' } as unknown as ExternalModuleBinding;
  await assert.rejects(createKnowledgeAgentTools({ ...binding, agentMethods: ['update_document'] }), /not declared/);
});

test('Agent configuration requires explicit supported runtime declarations and permits disabling all tools', () => {
  const binding = { enabled: true, implementationId: 'knowledge-core', contract: 'knowledge-core/v1',
    transport: 'rest-http-v1', endpoint: 'http://km', pilotDeckUserId: 'operator', methods: ['query', 'delete_document'] };
  for (const agentMethods of [['update_document'], ['invented']]) {
    const diagnostics: PilotConfigDiagnostic[] = [];
    const parsed = parseModulesConfig({ knowledge: { ...binding, agentMethods } }, '/tmp', diagnostics);
    assert.equal(parsed?.knowledge, undefined);
    assert.ok(diagnostics.some(row => row.code === 'MODULE_KNOWLEDGE_AGENT_METHODS_INVALID'));
  }
  const diagnostics: PilotConfigDiagnostic[] = [];
  const parsed = parseModulesConfig({ knowledge: { ...binding, agentMethods: [] } }, '/tmp', diagnostics);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual((parsed?.knowledge as ExternalModuleBinding).agentMethods, []);
});

test('Agent management uses full Wiki aliases, explicit revisions and the trusted space', async t => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/km/config') { res.end(JSON.stringify({ api_protocol: 'knowledge-core/v1', modules: { spaces: true, catalog: true, concepts: true }, operations: {
      query: { method: 'POST', path: '/api/km/v1/query' },
      delete_document: { method: 'DELETE', path: '/api/km/v1/documents/{document_id}' },
      list_okf_concepts: { method: 'GET', path: '/api/km/v1/knowledge-bases/{knowledge_base_id}/concepts' },
      upsert_okf_concept: { method: 'PUT', path: '/api/km/v1/knowledge-bases/{knowledge_base_id}/concepts/{concept_id:path}' },
    } })); return; }
    let raw = ''; for await (const part of req) raw += part;
    calls.push({ url: req.url!, body: raw ? JSON.parse(raw) : {} }); res.end('{"status":"ok"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const binding = { contract: 'knowledge-core/v1', methods: ['query', 'delete_document', 'list_concepts', 'upsert_concept'],
    endpoint: `http://127.0.0.1:${address.port}`, spaceId: 'allowed', spaces: [{ id: 'allowed' }] } as unknown as ExternalModuleBinding;
  assert.deepEqual((await createKnowledgeAgentTools(binding)).map(tool => tool.name), ['knowledge_query']);
  const tools = await createKnowledgeAgentTools({ ...binding, agentMethods: binding.methods });
  const remove = tools.find(tool => tool.name === 'knowledge_delete_document')!;
  assert.equal(remove.isReadOnly!({}), false); assert.equal(remove.isConcurrencySafe!({}), false);
  await assert.rejects(remove.execute({ document_id: 'd' }, context), /expected_updated_at/);
  await assert.rejects(remove.execute({ document_id: 'd', expected_updated_at: 'v', actor: 'admin' }, context), /Unknown/);
  await assert.rejects(remove.execute({ document_id: 'd', expected_updated_at: 'v', space_id: 'forged' }, context), /permission/);
  await remove.execute({ document_id: 'd', expected_updated_at: 'v' }, context);
  assert.match(calls.at(-1)!.url, /expected_updated_at=v/);
  const wiki = tools.find(tool => tool.name === 'knowledge_upsert_concept')!;
  await assert.rejects(wiki.execute({ concept_id: 'c', content_md: '# C', mode: 'edit' }, context), /expected_updated_at/);
  await wiki.execute({ concept_id: 'c', content_md: '# C', mode: 'create', knowledge_base_id: 'b', document_id: 'd' }, context);
  assert.match(calls.at(-1)!.url, /knowledge-bases\/b\/concepts\/c/);
  assert.equal(calls.at(-1)!.body.create_only, true);
  assert.deepEqual((await createKnowledgeAgentTools({ ...binding, agentMethods: binding.methods, readOnly: true })).map(tool => tool.name), ['knowledge_query', 'knowledge_list_concepts']);
});
