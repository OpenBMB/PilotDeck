import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), qa = process.env.BINDING_QA_ROOT;
assert.ok(qa);
const envPath = join(qa, 'env.json'), env = JSON.parse(readFileSync(envPath, 'utf8'));
const credentials = JSON.parse(readFileSync(join(qa, 'credentials.json'), 'utf8'));
const projectsPath = join(qa, 'projects.json'), projects = JSON.parse(readFileSync(projectsPath, 'utf8'));
const web = `http://127.0.0.1:${env.SERVER_PORT}`, configPath = env.PILOTDECK_CONFIG_PATH;
const originalConfig = readFileSync(configPath, 'utf8'), originalEnv = { ...env }, results = [];
function restart(...names) {
  const r = spawnSync(process.execPath, [join(pd, 'scripts/staffdeck-binding/restart.mjs'), ...names], {
    cwd: pd, env: { ...process.env, BINDING_QA_ROOT: qa, NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, 'Restart failed');
}
async function ready() {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(web + '/api/projects', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 250)); }
  throw new Error('Web unavailable');
}
async function call(path, body, project) {
  const response = await fetch(web + path, { method: body ? 'POST' : 'GET', headers: {
    'content-type': 'application/json', ...(project ? { 'X-PilotDeck-Project': project } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function native(path, body) {
  const response = await fetch(env.STAFFDECK_FORMAL_API_ORIGIN + path, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${credentials.actor.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json(); assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(value)}`); return value;
}
async function counts() {
  const response = await fetch(env.STAFFDECK_FORMAL_API_ORIGIN + '/api/v1/agents', {
    headers: { authorization: `Bearer ${credentials.admin.key}` } });
  const value = await response.json(); return value.data.length;
}
try {
  const before = await counts(), suffix = Date.now();
  env.STAFFDECK_PROJECT_BINDING_ENABLED = 'false';
  writeFileSync(envPath, JSON.stringify(env), { mode: 0o600 }); restart('web', 'gateway'); await ready();
  for (const name of ['ExistingC', 'ExplicitD']) projects[name] = (await call('/api/projects/create-workspace', {
    workspaceType: 'new', path: join(qa, 'workspace', name + suffix) })).project;
  assert.equal(await counts(), before);
  const explicit = await native('/api/enterprise/agents', { tenant_id: credentials.actor.tenantId, name: 'Explicit existing D ' + suffix, source_mode: 'blank' });
  const local = join(projects.ExplicitD.fullPath, '.pilotdeck'); mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'pilotdeck.yaml'), stringify({ modules: { knowledge: { agentId: explicit.id },
    sop: { discoveryAgentId: explicit.id, management: { agentId: explicit.id } } } }));
  env.STAFFDECK_PROJECT_BINDING_ENABLED = 'true'; writeFileSync(envPath, JSON.stringify(env), { mode: 0o600 });
  restart('web', 'gateway'); await ready();
  await call('/api/projects');
  assert.equal((await call(`/api/projects/${projects.ExistingC.name}/staffdeck-binding`)).status, 'pending');
  assert.equal(await counts(), before + 1);
  const c = await call(`/api/projects/${projects.ExistingC.name}/staffdeck-binding/ensure`, {});
  const d = await call(`/api/projects/${projects.ExplicitD.name}/staffdeck-binding/ensure`, {});
  assert.equal(c.status, 'bound'); assert.equal(d.status, 'bound'); assert.equal(d.agentId, explicit.id);
  assert.equal(await counts(), before + 2);
  projects.ExistingC.staffdeckBinding = c; projects.ExplicitD.staffdeckBinding = d;
  results.push({ id: 'B02', status: 'PASS', existingReadPending: true, explicitReused: true, countsBefore: before, countsAfter: before + 2 });
  const config = parse(originalConfig);
  const { applyProjectBinding } = await import(join(pd, 'dist/src/pilot/staffdeck/projectBinding.js'));
  const fixed = applyProjectBinding(config, projects.a.fullPath, env);
  fixed.modules.knowledge.callPath = '/v2/module/call';
  fixed.modules.knowledge.manifestPath = '/module-manifest';
  delete fixed.modules.knowledge.credentialEnv;
  env.STAFFDECK_PROJECT_BINDING_ENABLED = 'false'; env.STAFFDECK_COPY_TARGET_AGENT_ID = projects.a.staffdeckBinding.agentId;
  writeFileSync(configPath, stringify(fixed), { mode: 0o600 }); writeFileSync(envPath, JSON.stringify(env), { mode: 0o600 });
  restart('web', 'gateway'); await ready();
  assert.equal((await call(`/api/projects/${projects.a.name}/staffdeck-binding`)).status, 'disabled');
  assert.ok((await call('/api/modules/knowledge/call', { operation: 'list_bases', input: {} })).result.length > 0);
  assert.ok((await call('/api/modules/sop/management/call', { operation: 'list', input: {} })).result.data.length > 0);
  assert.ok((await call('/api/modules/staffdeck-copy/call', { operation: 'list_agents', input: {} })).result);
  const boundCount = await counts();
  writeFileSync(configPath, originalConfig, { mode: 0o600 }); writeFileSync(envPath, JSON.stringify(originalEnv), { mode: 0o600 });
  restart('web', 'gateway'); await ready();
  assert.equal((await call(`/api/projects/${projects.a.name}/staffdeck-binding/ensure`, {})).agentId, projects.a.staffdeckBinding.agentId);
  assert.equal(await counts(), boundCount);
  results.push({ id: 'C01-TOGGLE', status: 'PASS', fixedKnowledge: true, fixedSop: true, fixedCopy: true, bindingRestored: true });
} catch (error) { results.push({ id: 'COMPATIBILITY', status: 'FAIL', error: error.message }); process.exitCode = 1; }
finally {
  writeFileSync(configPath, originalConfig, { mode: 0o600 }); writeFileSync(envPath, JSON.stringify(originalEnv), { mode: 0o600 });
  writeFileSync(projectsPath, JSON.stringify(projects, null, 2)); restart('web', 'gateway');
  writeFileSync(join(qa, 'compatibility-result.json'), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results));
