import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url)), pd = resolve(scripts, '../..');
const sd = process.env.STAFFDECK_CHECKOUT || resolve(pd, '../StaffDeck');
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
assert.equal(new URL(env.STAFFDECK_FORMAL_API_ORIGIN).hostname, '127.0.0.1');
const project = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8')).b;
const web = `http://127.0.0.1:${env.SERVER_PORT}`, results = [];
const label = process.env.BINDING_QA_RUN_LABEL || String(Date.now());
assert.match(label, /^[a-zA-Z0-9_-]+$/);
const { GatewayTransport } = await import(pathToFileURL(join(pd, 'packages/sdk/dist/transport.js')));
function python(file, action) {
  const childEnv = { ...process.env, DATABASE_URL: `sqlite:///${join(qa, 'sd.sqlite')}`,
    PYTHONPATH: `${sd}/backend:${sd}/backend/src` }; delete childEnv.NODE_OPTIONS;
  const value = spawnSync(process.env.BINDING_QA_PYTHON, [join(scripts, file), ...(action ? [action] : [])], {
    cwd: sd, env: childEnv, encoding: 'utf8' });
  assert.equal(value.status, 0, value.stderr); return JSON.parse(value.stdout.trim().split('\n').at(-1));
}
function restart(...names) {
  const value = spawnSync(process.execPath, [join(scripts, 'restart.mjs'), ...names], {
    cwd: pd, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.equal(value.status, 0);
}
async function ready(url) {
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Service did not recover');
}
async function ensure() {
  const response = await fetch(`${web}/api/projects/${project.name}/staffdeck-binding/ensure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) });
  const binding = await response.json();
  assert.equal(binding.bindingId, project.staffdeckBinding.bindingId);
  assert.equal(binding.agentId, project.staffdeckBinding.agentId);
  return { http: response.status, binding };
}
async function chat() {
  const transport = new GatewayTransport({ url: env.PILOTDECK_GATEWAY_URL,
    token: readFileSync(join(qa, 'home/server-token'), 'utf8').trim(), clientName: 'test', requestTimeoutMs: 45000 });
  const events = [];
  try {
    await transport.connect();
    for await (const event of transport.stream('submit_turn', { projectKey: project.fullPath,
      workspaceCwd: project.fullPath, sessionKey: `binding-fault-chat-${Date.now()}`, channelKey: 'binding-test',
      message: 'Hello, answer briefly', mode: 'bypassPermissions' })) events.push(event);
    assert.ok(!events.some(event => event.type === 'error'), JSON.stringify(events));
    assert.ok(JSON.stringify(events).includes('Binding acceptance ordinary chat'));
    return { ordinaryChat: true, eventTypes: events.map(event => event.type) };
  } finally { transport.close(); }
}
async function check(name, action) {
  const started = Date.now();
  try { const evidence = await action(); results.push({ name, status: 'PASS', elapsedMs: Date.now() - started, evidence }); }
  catch (error) { results.push({ name, status: 'FAIL', elapsedMs: Date.now() - started, error: error.message }); }
  writeFileSync(join(qa, `faults-result-${label}.json`), JSON.stringify(results, null, 2));
  console.log(results.at(-1).status, name);
}
restart('gateway', 'web'); await ready(web + '/api/projects');
for (const action of ['revoke', 'downgrade', 'archive', 'missing']) {
  await check(`B05 ${action}`, async () => {
    const before = python('counts.py'); let failure, ordinary;
    python('mutate.py', action);
    try {
      failure = await ensure(); assert.equal(failure.binding.status, 'failed');
      assert.ok(failure.binding.error?.code, 'State response must explain binding failure');
      ordinary = await chat();
      const denied = await fetch(web + '/api/modules/knowledge/call', { method: 'POST', headers: {
        'content-type': 'application/json', 'X-PilotDeck-Project': project.name },
        body: JSON.stringify({ operation: 'list_bases', input: {} }) });
      assert.ok(denied.status >= 400);
    } finally { python('mutate.py', 'restore'); }
    const restored = await ensure(); assert.equal(restored.binding.status, 'bound');
    assert.deepEqual(python('counts.py'), before);
    return { failure, restored, before, after: python('counts.py'), ...ordinary };
  });
}
await check('B05 Gateway unavailable preserves original target', async () => {
  const before = python('counts.py'), originalEnv = readFileSync(join(qa, 'env.json'), 'utf8');
  // Point only the isolated Web bridge at an unavailable loopback endpoint.
  writeFileSync(join(qa, 'env.json'), JSON.stringify({ ...env,
    PILOTDECK_GATEWAY_URL: 'ws://127.0.0.1:1/ws', PILOTDECK_BRIDGE_TIMEOUT: '2000' }), { mode: 0o600 });
  let failure;
  try { restart('web'); await ready(web + '/api/auth/status'); failure = await ensure(); assert.equal(failure.binding.status, 'failed'); }
  finally { writeFileSync(join(qa, 'env.json'), originalEnv, { mode: 0o600 }); restart('web'); }
  await ready(web + '/api/projects');
  const restored = await ensure(); assert.equal(restored.binding.status, 'bound');
  assert.deepEqual(python('counts.py'), before);
  return { failure, restored, before, after: python('counts.py'), chatRequiresRunningGateway: true };
});
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
