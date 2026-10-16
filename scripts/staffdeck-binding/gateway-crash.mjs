import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const scripts = dirname(fileURLToPath(import.meta.url)), pd = resolve(scripts, '../..');
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const env = JSON.parse(readFileSync(join(qa, 'env.json'))), results = [];
function counts() {
  const value = spawnSync(process.env.BINDING_QA_PYTHON, [join(scripts, 'counts.py')], {
    env: { ...process.env, DATABASE_URL: `sqlite:///${qa}/sd.sqlite` }, encoding: 'utf8' });
  assert.equal(value.status, 0, value.stderr); return JSON.parse(value.stdout);
}
for (const phase of ['request-outstanding', 'loaded-response-held']) {
  const started = Date.now(), before = counts();
  const home = join(qa, 'home'), root = mkdtempSync(join(qa, 'gateway-crash-project-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }), sockets = new Set();
  await new Promise(done => server.once('listening', done));
  let child, requestId, observed = false, acknowledged = false;
  server.on('connection', downstream => {
    const upstream = new WebSocket(env.PILOTDECK_GATEWAY_URL), queue = [];
    sockets.add(downstream); sockets.add(upstream);
    upstream.on('open', () => queue.splice(0).forEach(item => upstream.send(item)));
    downstream.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.method === 'reload_extensions') {
        observed = true; requestId = frame.id;
        if (phase === 'request-outstanding') {
          upstream.send(String(raw));
          child.kill('SIGKILL');
          return;
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(String(raw)); else queue.push(String(raw));
    });
    upstream.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.id === requestId && frame.type === 'response' && phase === 'loaded-response-held') {
        assert.equal(frame.ok, true); acknowledged = true;
        child.kill('SIGKILL'); return;
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(String(raw));
    });
    upstream.on('error', () => downstream.close());
  });
  try {
    child = spawn(process.execPath, [join(scripts, 'gateway-worker.mjs'), pd, qa, home, root,
      `ws://127.0.0.1:${server.address().port}`], { env: { ...process.env, NODE_OPTIONS: '' } });
    let error = ''; child.stderr.on('data', chunk => error += chunk);
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    const exit = await new Promise(done => child.on('exit', (code, signal) => done({ code, signal })));
    clearTimeout(timer); assert.equal(exit.signal, 'SIGKILL', error); assert.ok(observed);
    if (phase === 'loaded-response-held') assert.ok(acknowledged);
    const path = join(home, 'staffdeck/project-bindings.json'), binding = JSON.parse(readFileSync(path)).projects.find(row => row.projectRoot === root);
    assert.equal(binding.status, 'binding'); assert.ok(binding.agentId);
    const retry = spawnSync(process.execPath, [join(scripts, 'gateway-worker.mjs'), pd, qa, home, root], {
      env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(retry.status, 0, retry.stderr);
    const restored = JSON.parse(retry.stdout.trim().split('\n').at(-1));
    assert.equal(restored.status, 'bound'); assert.equal(restored.agentId, binding.agentId);
    assert.equal(restored.bindingId, binding.bindingId);
    const after = counts(); assert.equal(after.agents, before.agents + 1); assert.equal(after.mappings, before.mappings + 1);
    results.push({ id: 'B03-GATEWAY-CRASH', phase, status: 'PASS', outstandingRequestObserved: true,
      acknowledged, bindingId: binding.bindingId, agentId: binding.agentId, before, after, elapsedMs: Date.now() - started });
  } catch (error) { results.push({ id: 'B03-GATEWAY-CRASH', phase, status: 'FAIL', error: error.message, elapsedMs: Date.now() - started }); }
  finally { for (const socket of sockets) socket.terminate(); await new Promise(done => server.close(done)); }
  writeFileSync(join(qa, 'gateway-crash-result.json'), JSON.stringify(results, null, 2));
  console.log(results.at(-1).status, phase);
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
