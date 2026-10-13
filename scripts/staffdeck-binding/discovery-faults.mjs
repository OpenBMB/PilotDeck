import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { StaffDeckSopDiscoveryClient } from '../../dist/src/sop/staffdeck/StaffDeckSopDiscoveryClient.js';
import { applyProjectBinding } from '../../dist/src/pilot/staffdeck/projectBinding.js';
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const bindingsPath = join(qa, 'home/staffdeck/project-bindings.json');
const before = readFileSync(bindingsPath, 'utf8');
const counts = () => {
  const result = spawnSync(process.env.BINDING_QA_PYTHON, [new URL('./counts.py', import.meta.url).pathname], {
    env: { ...process.env, DATABASE_URL: `sqlite:///${qa}/sd.sqlite` }, encoding: 'utf8',
  });
  assert.equal(result.status, 0); return JSON.parse(result.stdout);
};
const initialCounts = counts(), results = [];
let mode = 'delay';
let delayMs = 80;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  await delay(delayMs);
  if (res.destroyed) return;
  if (mode === '503') { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'PUBLIC_HOST_SOP_ROUTE_UNAVAILABLE' })); return; }
  try {
    const upstream = await fetch(env.STAFFDECK_FORMAL_API_ORIGIN + req.url, { method: req.method,
      headers: { authorization: req.headers.authorization, 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
    res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(await upstream.text());
  } catch { res.writeHead(502); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/api/v1`;
const config = applyProjectBinding({}, projects.a.fullPath, env);
const client = timeoutMs => new StaffDeckSopDiscoveryClient(origin, config.modules.sop.discoveryAgentId,
  env.STAFFDECK_SOP_MANAGEMENT_API_KEY, { timeoutMs });
const input = { message: 'Hello, ordinary conversation only.', sessionId: `binding-delay-${Date.now()}` };
async function check(name, action) {
  const started = Date.now();
  try { results.push({ name, status: 'PASS', evidence: await action(), elapsedMs: Date.now() - started }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.message, elapsedMs: Date.now() - started }); }
}
try {
  await check('controlled-timeout', async () => { await assert.rejects(client(20).route(input), { code: 'SOP_DISCOVERY_UNAVAILABLE' }); });
  await check('caller-cancellation', async () => {
    const controller = new AbortController(); const pending = client(90000).route({ ...input, signal: controller.signal });
    controller.abort(); await assert.rejects(pending, { code: 'SOP_DISCOVERY_UNAVAILABLE' });
  });
  await check('upstream-503', async () => {
    mode = '503'; await assert.rejects(client(90000).route(input), { code: 'PUBLIC_HOST_SOP_ROUTE_UNAVAILABLE' });
  });
  await check('real-route-recovery', async () => {
    mode = 'delay'; delayMs = 31000;
    const started = Date.now();
    const result = await client(config.modules.sop.discoveryTimeoutMs).route(input);
    assert.ok(Date.now() - started >= 30000);
    assert.ok(result.decision); assert.equal(readFileSync(bindingsPath, 'utf8'), before);
    assert.deepEqual(counts(), initialCounts);
    return { decision: result.decision, agentId: config.modules.sop.discoveryAgentId, counts: initialCounts,
      timeoutMs: config.modules.sop.timeoutMs, discoveryTimeoutMs: config.modules.sop.discoveryTimeoutMs, injectedDelayMs: delayMs };
  });
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  writeFileSync(join(qa, 'discovery-faults-result.json'), JSON.stringify(results, null, 2));
}
console.log(results.map(row => `${row.status} ${row.name}`).join('\n'));
if (results.some(row => row.status === 'FAIL')) process.exitCode = 1;
