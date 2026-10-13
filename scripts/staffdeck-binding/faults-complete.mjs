import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qa, pd, env, envPath, credentials, projects, web, ready, restart, python, request, recorder } from './qa.mjs';
const { GatewayTransport } = await import(pathToFileURL(join(pd, 'packages/sdk/dist/transport.js')));
const report = recorder('faults-complete');
const originalEnv = readFileSync(envPath, 'utf8');
const project = projects.b, sessionKey = `binding-rotation-${Date.now()}`;
async function ensure() {
  const r = await request(`/api/projects/${project.name}/staffdeck-binding/ensure`, {});
  assert.equal(r.value.bindingId, project.staffdeckBinding.bindingId);
  assert.equal(r.value.agentId, project.staffdeckBinding.agentId);
  return r.value;
}
async function chat() {
  const t = new GatewayTransport({ url: env.PILOTDECK_GATEWAY_URL,
    token: readFileSync(join(qa, 'home/server-token'), 'utf8').trim(), clientName: 'test', requestTimeoutMs: 45000 });
  const events = [];
  try {
    await t.connect();
    for await (const event of t.stream('submit_turn', { projectKey: project.fullPath, workspaceCwd: project.fullPath,
      sessionKey, channelKey: 'binding-test', message: 'Hello, answer briefly', mode: 'bypassPermissions' })) events.push(event);
    assert.ok(!events.some(e => e.type === 'error'), JSON.stringify(events.filter(e => e.type === 'error')));
    assert.ok(JSON.stringify(events).includes('Binding acceptance ordinary chat'));
    return events.map(e => e.type);
  } finally { t.close(); }
}
await report.check('B05-CONTROLLED-SD-TIMEOUT', async () => {
  const before = python('counts.py');
  const pids = JSON.parse(readFileSync(join(qa, 'pids.json')));
  process.kill(pids.sd, 'SIGSTOP');
  let failure;
  try { failure = await ensure(); assert.equal(failure.status, 'failed'); assert.ok(failure.error?.code); }
  finally { process.kill(pids.sd, 'SIGCONT'); }
  await ready(env.STAFFDECK_FORMAL_API_ORIGIN + '/api/health');
  const restored = await ensure(); assert.equal(restored.status, 'bound');
  assert.deepEqual(python('counts.py'), before);
  const ordinaryChatEvents = await chat();
  return { failure, restored, before, after: python('counts.py'), ordinaryChatEvents,
    injection: 'SIGSTOP formal isolated SD; binding request expires at its configured 10000ms deadline' };
});
await report.check('B05-CREDENTIAL-ROTATION-EXISTING-SESSION', async () => {
  const before = python('counts.py'); await chat();
  const oldKey = env.STAFFDECK_SOP_MANAGEMENT_API_KEY;
  const response = await fetch(env.STAFFDECK_FORMAL_API_ORIGIN + `/api/auth/me/api-credentials/${credentials.actor.credentialId}/rotate`, {
    method: 'POST', headers: { authorization: `Bearer ${credentials.actor.token}` } });
  assert.equal(response.status, 200); const rotated = await response.json();
  assert.equal(rotated.id, credentials.actor.credentialId);
  credentials.actor.key = rotated.api_key;
  writeFileSync(join(qa, 'credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
  const old = await fetch(env.STAFFDECK_FORMAL_API_ORIGIN + '/api/v1/agents', { headers: { authorization: `Bearer ${oldKey}` } });
  assert.equal(old.status, 401);
  const failure = await ensure(); assert.equal(failure.status, 'failed');
  const replacement = { ...env, STAFFDECK_SOP_MANAGEMENT_API_KEY: rotated.api_key };
  writeFileSync(envPath, JSON.stringify(replacement), { mode: 0o600 });
  restart('gateway', 'web'); await ready();
  const restored = await ensure(); assert.equal(restored.status, 'bound');
  const events = await chat(); assert.deepEqual(python('counts.py'), before);
  return { sessionKey, oldCredentialStatus: old.status, credentialIdStable: true,
    failure, restored, events, before, after: python('counts.py') };
});
// Keep the rotated fixture key current for subsequent tests; never export it.
if (report.results.some(r => r.id.includes('ROTATION') && r.status === 'FAIL')) {
  const saved = JSON.parse(originalEnv);
  saved.STAFFDECK_SOP_MANAGEMENT_API_KEY = credentials.actor.key;
  writeFileSync(envPath, JSON.stringify(saved), { mode: 0o600 }); restart('gateway', 'web');
}
