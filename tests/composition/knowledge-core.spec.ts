import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createKnowledgeModulePort } from '../../src/composition/domainPorts.js';
import { parseModulesConfig } from '../../src/pilot/config/parseModulesConfig.js';
import type { PilotConfigDiagnostic } from '../../src/pilot/config/types.js';

test('unsupported independent methods are rejected during configuration', () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseModulesConfig({ knowledge: { enabled: true, implementationId: 'knowledge-core',
    contract: 'knowledge-core/v1', transport: 'rest-http-v1', endpoint: 'http://km',
    spaceId: 'local', spaces: [{ id: 'local' }], pilotDeckUserId: 'operator', methods: ['query', 'invented'],
  } }, '/tmp', diagnostics);
  assert.equal(config?.knowledge, undefined);
  assert.ok(diagnostics.some(row => row.severity === 'fatal'));
});

test('runtime space directory is limited to the binding even with a broad service credential', async t => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    if (_req.url === '/api/km/config') { res.end(JSON.stringify({ api_protocol: 'knowledge-core/v1', modules: { spaces: true }, operations: { list_spaces: { method: 'GET', path: '/api/km/v1/spaces' } } })); return; }
    res.end(JSON.stringify([{ id: 'local' }, { id: 'other-host' }]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing port');
  const diagnostics: PilotConfigDiagnostic[] = [];
  const modules = parseModulesConfig({ knowledge: { enabled: true, implementationId: 'knowledge-core',
    contract: 'knowledge-core/v1', transport: 'rest-http-v1', endpoint: `http://127.0.0.1:${address.port}`,
    spaceId: 'local', spaces: [{ id: 'local' }], pilotDeckUserId: 'operator', methods: ['query', 'list_spaces'],
  } }, '/tmp', diagnostics);
  const binding = modules?.knowledge;
  if (!binding || !('endpoint' in binding)) throw Error('Missing binding');
  assert.deepEqual(await createKnowledgeModulePort(binding).call('list_spaces', {}), [{ id: 'local' }]);
});

test('independent KM config and runtime query need no StaffDeck identity or service', async t => {
  const calls: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/api/km/config') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ api_protocol: 'knowledge-core/v1', modules: { spaces: true }, operations: { query: { method: 'POST', path: '/api/km/v1/query' } } })); return; }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    calls.push({ path: req.url, input: JSON.parse(Buffer.concat(parts).toString()), authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ chunks: [{ id: 'evidence' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing port');
  const diagnostics: PilotConfigDiagnostic[] = [];
  const modules = parseModulesConfig({ knowledge: {
    enabled: true, implementationId: 'knowledge-core', contract: 'knowledge-core/v1', transport: 'rest-http-v1',
    endpoint: `http://127.0.0.1:${address.port}`, spaceId: 'local', spaces: [{ id: 'local', name: 'Local' }],
    pilotDeckUserId: 'operator',
  } }, '/tmp', diagnostics);
  assert.deepEqual(diagnostics, []);
  const binding = modules?.knowledge;
  if (!binding || !('implementationId' in binding) || binding.transport !== 'rest-http-v1') throw Error('Missing binding');
  const port = createKnowledgeModulePort(binding);
  await assert.rejects(port.call('query', {
    query: 'receipts', space_id: 'forged', actor_user_id: 'admin', use_model: true,
  }), /identity comes from its binding/);
  const result = await port.call('query', { query: 'receipts' });
  assert.deepEqual(result, { chunks: [{ id: 'evidence' }] });
  assert.deepEqual(calls, [{ path: '/api/km/v1/query?space_id=local', authorization: undefined,
    input: { query: 'receipts', space_id: 'local', use_model: true, max_chunks: 6 },
  }]);
});

test('independent KM port propagates upstream failure and timeout', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/api/km/config') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ api_protocol: 'knowledge-core/v1', modules: { spaces: true }, operations: { query: { method: 'POST', path: '/api/km/v1/query' }, resolve_citation: { method: 'GET', path: '/api/km/v1/citations/{chunk_id}' } } })); return; }
    if (req.url?.includes('timeout')) return;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Knowledge unavailable' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing port');
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseModulesConfig({ knowledge: {
    enabled: true, implementationId: 'knowledge-core', contract: 'knowledge-core/v1', transport: 'rest-http-v1',
    endpoint: `http://127.0.0.1:${address.port}`, spaceId: 'local', spaces: [{ id: 'local', name: 'Local' }],
    pilotDeckUserId: 'operator', timeoutMs: 25,
  } }, '/tmp', diagnostics);
  const binding = config?.knowledge;
  if (!binding || !('implementationId' in binding) || binding.transport !== 'rest-http-v1') throw Error('Missing binding');
  const port = createKnowledgeModulePort(binding);
  await assert.rejects(port.call('query', { query: 'policy' }), { message: 'Knowledge unavailable', status: 503 });
  await assert.rejects(port.call('resolve_citation', { chunk_id: 'timeout' }), { name: 'TimeoutError' });
});
