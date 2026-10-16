import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalKnowledgeRuntime, validateLocalKnowledgeRuntime } from '../../src/composition/localKnowledgeRuntime.mjs';
import { parseModulesConfig } from '../../src/pilot/config/parseModulesConfig.js';
import type { PilotConfigDiagnostic } from '../../src/pilot/config/types.js';

const binding = { enabled: true, implementationId: 'knowledge-core', contract: 'knowledge-core/v1',
  transport: 'rest-http-v1', endpoint: 'http://127.0.0.1:18891', pilotDeckUserId: '1',
  localRuntime: { python: process.execPath } };

test('managed KM configuration preserves local paths and rejects remote or ambiguous launches', () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const modules = parseModulesConfig({ knowledge: binding }, '/tmp', diagnostics);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(modules?.knowledge && 'localRuntime' in modules.knowledge && modules.knowledge.localRuntime, binding.localRuntime);
  for (const endpoint of ['http://remote:18891', 'https://127.0.0.1:18891', 'http://127.0.0.1:18891/path', 'http://127.0.0.1'])
    assert.throws(() => validateLocalKnowledgeRuntime(binding.localRuntime, endpoint));
  for (const value of [{ python: 'python3' }, { python: process.execPath, args: [] }, { python: process.execPath, startupTimeoutMs: -1 }])
    assert.throws(() => validateLocalKnowledgeRuntime(value, binding.endpoint));
  const errors: PilotConfigDiagnostic[] = [];
  parseModulesConfig({ tools: { ...binding, contract: 'example', localRuntime: binding.localRuntime } }, '/tmp', errors);
  assert.ok(errors.some(row => row.code === 'MODULE_LOCAL_RUNTIME_INVALID'));
});

test('external and disabled KM never create a process', async () => {
  await (await startLocalKnowledgeRuntime({ ...binding, localRuntime: undefined })).stop();
  await (await startLocalKnowledgeRuntime({ ...binding, enabled: false })).stop();
});

test('managed KM refuses an occupied port and leaves the listener alive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-managed-km-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((_req, res) => res.end('existing service'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  await assert.rejects(startLocalKnowledgeRuntime({ ...binding, endpoint: `http://127.0.0.1:${address.port}`,
    localRuntime: { python: process.execPath, dataDirectory: directory } }), /occupied/);
  assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'existing service');
  await assert.rejects(access(join(directory, '.runtime-lock')));
});

test('failed Python startup releases its data lock and records diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-failed-km-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(startLocalKnowledgeRuntime({ ...binding, localRuntime: {
    python: join(directory, 'missing-python'), dataDirectory: directory,
  } }), /ENOENT/);
  await assert.rejects(access(join(directory, '.runtime-lock')));
  await access(join(directory, 'service.log'));
});

test('cancelled startup releases the child and lock before returning', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-cancelled-km-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(startLocalKnowledgeRuntime({ ...binding, localRuntime: {
    python: process.execPath, dataDirectory: directory,
  } }, { signal: abort.signal }), /abort/i);
  await assert.rejects(access(join(directory, '.runtime-lock')));
});

test('managed KM forwards explicitly configured capability credentials without inheriting KM startup overrides', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pd-hosted-km-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const python = join(directory, 'python.mjs');
  await writeFile(python, `#!${process.execPath}
import {createServer} from 'node:http';
if (process.env.KM_TEST_HOST_TOKEN !== 'test-capability' || process.env.KM_READ_ONLY || process.env.STAFFDECK_TEST_OVERRIDE || process.env.PYTHONPATH) process.exit(2);
const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/api/km/config' ? {api_protocol: 'knowledge-core/v1'} : {status: 'ready'})); });
server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
process.on('SIGTERM', () => server.close());
`, { mode: 0o755 });
  const capabilitiesFile = join(directory, 'capabilities.json');
  await writeFile(capabilitiesFile, JSON.stringify([{ credential_env: 'KM_TEST_HOST_TOKEN' }]));
  const runtime = await startLocalKnowledgeRuntime({ ...binding, endpoint: `http://127.0.0.1:${port}`,
    localRuntime: { python, dataDirectory: directory, capabilitiesFile, startupTimeoutMs: 2000 } }, {
    env: { ...process.env, KM_TEST_HOST_TOKEN: 'test-capability', KM_READ_ONLY: 'true', STAFFDECK_TEST_OVERRIDE: 'unused', PYTHONPATH: '/invalid' }, log: () => {},
  });
  await runtime.stop();
  await assert.rejects(access(join(directory, '.runtime-lock')));
});
