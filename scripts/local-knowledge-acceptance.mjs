import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { startLocalKnowledgeRuntime } from '../src/composition/localKnowledgeRuntime.mjs';

const output = resolve(process.env.KM_LOCAL_EVIDENCE || 'docs/validation/2026-10-16-local-knowledge');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'instance-'));
const python = process.env.KM_LOCAL_PYTHON;
assert.ok(python, 'KM_LOCAL_PYTHON must point to an independently installed KM Python');
const report = { status: 'not_accepted', directory, steps: [] };
let child, childExit;
async function freePort() {
  const server = createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}
const kmPort = await freePort();
const webPort = await freePort();
const gatewayPort = await freePort();
const endpoint = `http://127.0.0.1:${kmPort}`;
const configPath = join(directory, 'pilotdeck.yaml');
const configFile = join(directory, 'configuration.json');
const dataDirectory = join(directory, 'data');
const logs = await open(join(directory, 'pd.log'), 'a');
const env = { ...process.env, NODE_OPTIONS: '', PILOT_HOME: directory, PILOTDECK_CONFIG_PATH: configPath,
  DATABASE_PATH: join(directory, 'auth.sqlite'), SERVER_PORT: String(webPort), HOST: '127.0.0.1',
  PILOTDECK_GATEWAY_PORT: String(gatewayPort), PILOTDECK_SKIP_BROWSER_OPEN: '1', PILOTDECK_DISABLE_LOCAL_AUTH: '1' };
const binding = { enabled: true, implementationId: 'knowledge-core', contract: 'knowledge-core/v1', transport: 'rest-http-v1',
  frontendModule: 'knowledge-core', endpoint, pilotDeckUserId: '1', methods: ['query', 'resolve_citation', 'identity', 'list_models',
    'list_spaces', 'list_bases', 'get_base', 'create_base', 'list_documents', 'get_document', 'import_document', 'get_job'],
  spaceId: 'local', spaces: [{ id: 'local', name: 'Local' }],
  localRuntime: { python, dataDirectory, configFile } };
async function json(method, path, body, base = endpoint) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify({ path, status: response.status, result }));
  report.steps.push({ method, path, status: response.status, result });
  return result;
}
async function waitReady(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error('PD exited before readiness');
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.ok) return; } catch {}
    await delay(150);
  }
  throw Error('Readiness timed out: ' + url);
}
async function start(entry) {
  child = spawn(process.execPath, entry, { env, stdio: ['ignore', logs.fd, logs.fd], cwd: process.cwd() });
  childExit = once(child, 'exit');
  await waitReady(endpoint + '/health/ready');
  if (entry[0].includes('Supervisor')) {
    await waitReady(`http://127.0.0.1:${webPort}/health`);
    await waitReady(`http://127.0.0.1:${webPort}/api/modules/knowledge/core/configuration`);
  } else await waitReady(`http://127.0.0.1:${gatewayPort}/health`);
  report.steps.push({ check: 'PD and managed KM ready', entry });
}
async function stop() {
  if (!child) return;
  child.kill('SIGINT');
  let timer;
  try { await Promise.race([childExit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('PD did not exit normally')), 25_000); })]); }
  finally { clearTimeout(timer); }
  child = undefined;
  let alive = true;
  try { await fetch(endpoint + '/health/ready', { signal: AbortSignal.timeout(500) }); } catch { alive = false; }
  assert.equal(alive, false, 'Managed KM must stop with PD');
  report.steps.push({ check: 'PD exit stopped managed KM' });
}
try {
  await writeFile(configFile, JSON.stringify({ preset: 'full', modules: { authentication: false, publication: false } }));
  await writeFile(configPath, stringify({ schemaVersion: 1, agent: { model: 'local/test' },
    model: { providers: { local: { protocol: 'openai', url: 'http://127.0.0.1:9/v1', apiKey: 'acceptance-unused', models: { test: {} } } } },
    router: { enabled: false }, modules: { knowledge: binding, sop: { enabled: false } } }));
  await start(['ui/server/webRuntimeSupervisor.js', 'start-built']);
  await assert.rejects(startLocalKnowledgeRuntime(binding, { env }), /already managed/);
  await json('POST', '/api/km/v1/spaces', { id: 'local', name: 'Local' });
  const base = await json('POST', '/api/modules/knowledge/core/knowledge-bases', { name: 'Managed runtime' }, `http://127.0.0.1:${webPort}`);
  const job = await json('POST', `/api/modules/knowledge/core/knowledge-bases/${base.id}/documents`, {
    filename: 'managed.md', title: 'Managed persistence', content_base64: Buffer.from('# Managed KM\n\nLOCALMANAGED731 receipts are retained for 45 days.').toString('base64'),
  }, `http://127.0.0.1:${webPort}`);
  const jobId = job.id || job.job_id;
  let terminal;
  for (let i = 0; i < 100; i++) {
    terminal = await json('GET', `/api/km/v1/jobs/${jobId}?space_id=local`);
    if (['succeeded', 'failed', 'cancelled'].includes(terminal.status)) break;
    await delay(100);
  }
  assert.equal(terminal.status, 'succeeded');
  const query = await json('POST', '/api/modules/knowledge/core/query', { query: 'LOCALMANAGED731', use_model: false }, `http://127.0.0.1:${webPort}`);
  assert.ok(query.chunks.length > 0);
  const documents = await json('GET', `/api/km/v1/documents?space_id=local&knowledge_base_id=${base.id}`);
  assert.equal(documents.length, 1);
  await stop();
  await start(['ui/server/webRuntimeSupervisor.js', 'start-built']);
  const persisted = await json('GET', `/api/km/v1/documents?space_id=local&knowledge_base_id=${base.id}`);
  assert.equal(persisted[0].id, documents[0].id);
  await stop();
  await start(['--import', 'tsx', 'src/cli/pilotdeck.ts', 'server']);
  assert.equal((await json('GET', `/api/km/v1/documents?space_id=local&knowledge_base_id=${base.id}`))[0].id, documents[0].id);
  await stop();
  report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (child) { try { await stop(); } catch (error) { report.cleanupError = error.stack; child?.kill('SIGKILL'); } }
  await logs.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, error: report.error, output }));
}
