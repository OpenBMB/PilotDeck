import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { readLocalSopConfig } from './localSopRuntime.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pd-managed-sop-'));
  const config = join(root, 'pilotdeck.yaml');
  const env = { ...process.env, PILOT_HOME: root, PILOTDECK_CONFIG_PATH: config };
  const write = (endpoint = 'http://127.0.0.1:8091', extra = '') => writeFileSync(config, `modules:
  sop:
    enabled: true
    hostAdapter: pilotdeck
    implementationId: portable-sop
    contract: sop.lifecycle/v3
    transport: sop-http-v3
    endpoint: ${endpoint}
    localRuntime:
      enabled: true
      python: ${process.env.SOP_TEST_PYTHON || 'python3'}
      knowledgeEnabled: false
      versionManagementEnabled: true
${extra}`);
  return { root, config, env, write };
}

test('local service is opt-in, validates loopback and feature policy', () => {
  const f = fixture();
  try {
    assert.equal(readLocalSopConfig(f.env), null);
    f.write();
    assert.equal(readLocalSopConfig(f.env).knowledge, false);
    f.write('https://remote.example');
    assert.throws(() => readLocalSopConfig(f.env), /loopback/);
    f.write('http://127.0.0.1:8091', '      versionManagementEnabled: wrong');
    assert.throws(() => readLocalSopConfig(f.env));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('real managed Python service installs, persists state, restarts and exits with owner', {
  skip: process.env.SOP_TEST_REAL_RUNTIME !== '1', timeout: 240000,
}, async () => {
  const f = fixture();
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  f.write(endpoint);
  let running;
  const start = async () => {
    let output = '';
    const child = spawn(process.execPath, ['ui/server/localSopRuntime.mjs'], {
      env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    running = { child, exited };
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { output += value; });
    return Promise.race([
      new Promise(resolve => child.once('message', resolve)),
      exited.then(value => { throw new Error(`Exited before ready: ${JSON.stringify(value)}\n${output}`); }),
    ]);
  };
  const stop = async () => {
    running.child.kill('SIGTERM'); await running.exited; running = undefined;
    await assert.rejects(fetch(`${endpoint}/healthz`, { signal: AbortSignal.timeout(1000) }));
  };
  try {
    const ready = await start();
    assert.equal(ready.type, 'pilotdeck:sop-ready');
    const duplicate = spawn(process.execPath, ['ui/server/localSopRuntime.mjs'], { env: f.env, stdio: 'ignore' });
    const duplicateExit = await new Promise(resolve => duplicate.once('exit', resolve));
    assert.equal(duplicateExit, 1);
    assert.equal((await fetch(`${endpoint}/healthz`)).status, 200);
    const call = async (path, body) => {
      const response = await fetch(`${endpoint}${path}`, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${ready.publishToken}`,
      }, body: JSON.stringify(body) });
      const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
    };
    const features = await call('/v1/management/call', { operation: 'features', input: {} });
    assert.deepEqual(features.result, { knowledge: false, versionManagement: true });
    const draft = await call('/v1/management/call', { operation: 'create', input: { content: {
      skill_id: 'managed_test', version: '1.0.0', name: 'Managed', start_node_id: 'done', terminal_node_ids: ['done'],
      nodes: [{ node_id: 'done', type: 'response', instruction: 'Finish' }], edges: [],
    } } });
    await stop();
    const restarted = await start();
    assert.equal(restarted.publishToken, ready.publishToken);
    const catalog = await call('/v1/management/call', { operation: 'list', input: {} });
    assert.equal(catalog.result.drafts[0].id, draft.result.id);
    assert.equal(readFileSync(join(f.root, 'sop-runtime/publish-token'), 'utf8'), ready.publishToken);
    await stop();
  } finally {
    if (running) { running.child.kill('SIGTERM'); await running.exited; }
    rmSync(f.root, { recursive: true, force: true });
  }
});
