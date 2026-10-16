import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { parse, stringify } from 'yaml';
import { startModelServer } from './model-server.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const pd = resolve(scripts, '../..');
const sd = resolve(process.env.STAFFDECK_CHECKOUT || join(pd, '../StaffDeck'));
const python = process.env.BINDING_QA_PYTHON;
assert.ok(python, 'Set BINDING_QA_PYTHON to the prepared StaffDeck Python executable');
const qa = process.env.BINDING_QA_ROOT || mkdtempSync(join(tmpdir(), 'binding-acceptance-'));
mkdirSync(qa, { recursive: true, mode: 0o700 });
const basePort = Number(process.env.BINDING_QA_PORT || 25510);
const origin = `http://127.0.0.1:${basePort}`;
const webOrigin = `http://127.0.0.1:${basePort + 3}`;
const home = join(qa, 'home'), workspace = join(qa, 'workspace');
mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
const base = { ...process.env }; delete base.NODE_OPTIONS;
const sdEnv = { ...base, PYTHONPATH: `${sd}/backend:${sd}/backend/src`,
  ULTRARAG_DOTENV: join(qa, 'absent.env'), DATABASE_URL: `sqlite:///${qa}/sd.sqlite`,
  DEMO_SEED_ENABLED: 'false', STARTUP_ORPHAN_CLEANUP_ENABLED: 'false',
  APP_SECRET: 'binding-isolated-acceptance-secret', HARNESS_V3_HOME: join(qa, 'sd-home'),
  HARNESS_V3_ROOT: process.env.HARNESS_V3_ROOT || '',
  HARNESS_RUNTIME_CONFIG_PATH: join(qa, 'sd-runtime.json'), BINDING_QA_ROOT: qa,
  STAFFDECK_PROJECT_BINDING_ENABLED: 'true', PILOTDECK_DOMAIN_HOST_ENABLED: 'true',
  PILOTDECK_APPROVAL_BRIDGE_ENABLED: 'true',
  PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${basePort + 2}/ws`,
  PILOTDECK_GATEWAY_TOKEN_PATH: join(home, 'server-token'), PILOTDECK_USER_ID: '1',
  STAFFDECK_COPY_TENANT_ID: 'binding-tenant', STAFFDECK_COPY_ACTOR_USER_ID: 'binding-actor' };
sdEnv.PYTHONPATH += `:${sd}/portable_sop/src`;
sdEnv.SOP_RUNTIME_ENDPOINT = `http://127.0.0.1:${basePort + 1}`;
const results = [], processes = new Map(), capture = [];
function run(command, args, cwd, env = base) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function start(name, command, args, cwd, env) {
  const log = openSync(join(qa, `${name}.log`), 'a', 0o600);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
  processes.set(name, child); return child;
}
async function stop(name) {
  const child = processes.get(name); if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(done => child.once('exit', done)),
    new Promise(done => setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000))]);
}
async function ready(url, name) {
  for (let i = 0; i < 180; i++) {
    const child = processes.get(name);
    if (child && child.exitCode !== null) throw new Error(`${name} exited; inspect ${qa}/${name}.log`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error(`${name} did not become ready: ${url}`);
}
async function check(id, name, action) {
  const started = Date.now();
  try { const evidence = await action(); results.push({ id, name, status: 'PASS', elapsedMs: Date.now() - started, evidence }); }
  catch (error) { results.push({ id, name, status: 'FAIL', elapsedMs: Date.now() - started, error: error.message }); }
  writeFileSync(join(qa, 'results.json'), JSON.stringify({ qa, pd, sd, basePort, results }, null, 2));
  console.log(`${results.at(-1).status} ${id} ${name}`);
}
let secrets, pdEnv, model;
const headers = project => ({ 'content-type': 'application/json', ...(project ? { 'X-PilotDeck-Project': project } : {}) });
async function call(path, body, project, method) {
  const response = await fetch(webOrigin + path, { method: method || (body ? 'POST' : 'GET'),
    headers: headers(project), body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(value)}`);
  return value;
}
function dbCounts() {
  return JSON.parse(run(python, [join(scripts, 'seed.py')], sd, sdEnv).trim().split('\n').at(-1));
}
async function register(name, type = 'new') {
  const path = join(workspace, name); if (type === 'existing') mkdirSync(path, { recursive: true });
  const value = await call('/api/projects/create-workspace', { workspaceType: type, path });
  assert.equal(value.project.staffdeckBinding.status, 'bound'); return value.project;
}
function startSD() { start('sd', python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(basePort)], sd, sdEnv); }
function startGateway() { start('gateway', process.execPath, [join(pd, 'dist/src/cli/pilotdeck.js'), 'server', '--port', String(basePort + 2)], workspace, pdEnv); }
function startWeb() { start('web', process.execPath, ['--import', 'tsx', join(pd, 'ui/server/index.js')], pd, pdEnv); }
try {
  assert.ok(existsSync(join(pd, 'dist/src/cli/pilotdeck.js')), 'Build PD before running acceptance');
  run(python, [join(scripts, 'seed.py')], sd, sdEnv);
  secrets = JSON.parse(readFileSync(join(qa, 'credentials.json'), 'utf8'));
  writeFileSync(join(home, 'server-token'), 'binding-acceptance-gateway-token', { mode: 0o600 });
  let config = { schemaVersion: 1, agent: { model: 'test/model' }, memory: { enabled: false },
    model: { providers: { test: { protocol: 'openai', url: `http://127.0.0.1:${basePort + 4}/v1`,
      apiKey: 'binding-test', models: { model: {} } } } },
    modules: { knowledge: { enabled: false }, sop: { enabled: false } } };
  if (process.argv.includes('--real')) {
    const source = parse(readFileSync(process.env.BINDING_QA_REAL_CONFIG || '/Users/a1/.pilotdeck/pilotdeck.yaml', 'utf8'));
    config.agent.model = process.env.BINDING_QA_REAL_MODEL || source.agent.model;
    config.model = source.model;
  } else {
    start('model', process.execPath, [join(scripts, 'model-server.mjs')], pd,
      { ...base, BINDING_QA_MODEL_PORT: String(basePort + 4), BINDING_QA_CAPTURE: join(qa, 'model-capture.json') });
    await ready(`http://127.0.0.1:${basePort + 4}/v1/models`, 'model');
  }
  writeFileSync(join(home, 'pilotdeck.yaml'), stringify(config), { mode: 0o600 });
  pdEnv = { ...base, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: join(home, 'pilotdeck.yaml'),
    DATABASE_PATH: join(home, 'auth.db'), STAFFDECK_PROJECT_BINDING_ENABLED: 'true',
    STAFFDECK_FORMAL_API_ORIGIN: origin, STAFFDECK_COPY_TENANT_ID: secrets.actor.tenantId,
    STAFFDECK_COPY_ACTOR_USER_ID: secrets.actor.userId, STAFFDECK_COPY_PILOTDECK_USER_ID: '1',
    STAFFDECK_COPY_USER_TOKEN: secrets.actor.token, STAFFDECK_SOP_MANAGEMENT_API_KEY: secrets.actor.key,
    STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID: secrets.actor.credentialId,
    STAFFDECK_APPROVAL_USER_ID: secrets.stranger.userId,
    STAFFDECK_SOP_RUNTIME_ORIGIN: `http://127.0.0.1:${basePort + 1}`,
    PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${basePort + 2}/ws`, PILOTDECK_GATEWAY_PORT: String(basePort + 2),
    PILOTDECK_DISABLE_LOCAL_AUTH: '1', WORKSPACES_ROOT: workspace, SERVER_PORT: String(basePort + 3), HOST: '127.0.0.1' };
  writeFileSync(join(qa, 'env.json'), JSON.stringify(pdEnv), { mode: 0o600 });
  start('sop', python, ['-m', 'uvicorn', 'staffdeck_sop_runtime.api:app', '--host', '127.0.0.1', '--port', String(basePort + 1)], sd,
    { ...sdEnv, SOP_RUNTIME_DB: join(qa, 'sop-runtime.sqlite') });
  await ready(`http://127.0.0.1:${basePort + 1}/healthz`, 'sop');
  for (const tenant of ['binding-tenant', 'binding-other-tenant']) {
    run(python, ['-m', 'app.skills.migrate_sop_runtime', '--tenant-id', tenant], sd, sdEnv);
  }
  sdEnv.SOP_RUNTIME_LEGACY_WRITES = 'disabled';
  startSD(); await ready(origin + '/api/health', 'sd');
  startGateway(); startWeb(); await ready(webOrigin + '/api/projects', 'web');
  const projects = {};
  await check('B01', 'new and existing registration, clone, no creation during reads', async () => {
    projects.a = await register('ProjectA'); projects.b = await register('ProjectB', 'existing');
    const source = join(qa, 'source-repo'); mkdirSync(source);
    run('git', ['init', source], qa); run('git', ['-C', source, '-c', 'user.name=Binding QA', '-c', 'user.email=binding@example.test', 'commit', '--allow-empty', '-m', 'fixture'], qa);
    const bare = join(qa, 'repo.git'); run('git', ['clone', '--bare', source, bare], qa);
    run('git', ['-C', bare, 'update-server-info'], qa);
    const gitServer = createServer((req, res) => {
      const path = resolve(qa, '.' + new URL(req.url, 'http://localhost').pathname);
      if (!path.startsWith(bare + '/')) { res.writeHead(404); res.end(); return; }
      try { res.end(readFileSync(path)); } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(done => gitServer.listen(0, '127.0.0.1', done));
    try {
      projects.clone = (await call('/api/projects/create-workspace', { workspaceType: 'new',
        path: join(workspace, 'clones'), githubUrl: `http://127.0.0.1:${gitServer.address().port}/repo.git` })).project;
      assert.equal(run('git', ['-C', projects.clone.fullPath, 'rev-parse', 'HEAD'], qa), run('git', ['-C', source, 'rev-parse', 'HEAD'], qa));
    } finally { await new Promise(done => gitServer.close(done)); }
    assert.equal(projects.clone.staffdeckBinding.status, 'bound');
    const before = dbCounts(); await call('/api/projects');
    await call(`/api/projects/${projects.a.name}/staffdeck-binding`);
    assert.deepEqual(dbCounts(), before);
    const again = await register('ProjectB', 'existing');
    assert.equal(again.staffdeckBinding.agentId, projects.b.staffdeckBinding.agentId);
    return { counts: dbCounts(), cloneEntry: 'create-workspace githubUrl using isolated local HTTP Git repository' };
  });
  await check('B03', '20 concurrent same-project ensure requests', async () => {
    assert.ok(projects.a);
    const before = dbCounts();
    const values = await Promise.all(Array.from({ length: 20 }, () => call(`/api/projects/${projects.a.name}/staffdeck-binding/ensure`, {})));
    assert.equal(new Set(values.map(value => value.agentId)).size, 1);
    assert.ok(values.every(value => value.status === 'bound'));
    assert.deepEqual(dbCounts(), before);
    return { requests: 20, before, after: dbCounts() };
  });
  await check('I01/I02/I05', 'project resources and first SOP publication', async () => {
    const a = projects.a.name, b = projects.b.name;
    for (const scope of ['general', 'sop_specific']) {
      const created = await call('/api/modules/knowledge/call', { operation: 'create_base', input: { name: `A ${scope} BINDING_MARKER`, capabilityScope: scope } }, a);
      const foreign = await fetch(webOrigin + '/api/modules/knowledge/call', { method: 'POST', headers: headers(b),
        body: JSON.stringify({ operation: 'get_base', input: { knowledgeBaseId: created.result.id } }) });
      assert.equal(foreign.status, 404);
    }
    assert.equal((await call('/api/modules/knowledge/call', { operation: 'list_bases', input: {} }, b)).result.length, 0);
    const overridden = await fetch(webOrigin + '/api/modules/staffdeck-sdk/call', { method: 'POST', headers: headers(a),
      body: JSON.stringify({ operation: 'list_knowledge_bases', scope: { kind: 'agent', agentId: projects.b.staffdeckBinding.agentId }, input: {} }) });
    assert.equal(overridden.status, 403);
    assert.equal((await call('/api/modules/sop/definitions', undefined, b)).definitions.length, 0);
    const card = { skill_id: 'binding_a_sop', name: 'Binding A SOP', version: '1.0.0', description: 'A binding acceptance',
      trigger_intents: ['BINDING_A_SOP'], nodes: [{ node_id: 'answer', type: 'respond', name: 'Answer',
        instruction: 'Return BINDING_A_COMPLETED then submit completed', capability_refs: { general_skill_ids: [], tool_ids: [], knowledge_base_ids: [] } }],
      edges: [], start_node_id: 'answer', terminal_node_ids: ['answer'] };
    const draft = await call('/api/modules/sop/management/call', { operation: 'create', input: { content: card } }, a);
    const publication = await call('/api/modules/sop/management/call', { operation: 'publish', input: { sopId: card.skill_id, draftId: draft.result.id } }, a);
    assert.equal(publication.result.sop.skill_id, card.skill_id);
    assert.equal((await call('/api/modules/sop/definitions', undefined, a)).definitions.length, 1);
    assert.equal((await call('/api/modules/sop/definitions', undefined, b)).definitions.length, 0);
    return { foreignResourceStatus: 404, overrideStatus: 403, publication: publication.runtime };
  });
  await check('C01', 'delete/readd and independent process restarts preserve binding', async () => {
    const b = projects.b;
    await call(`/api/projects/${b.name}`, undefined, undefined, 'DELETE');
    const restored = await register('ProjectB', 'existing');
    assert.equal(restored.staffdeckBinding.bindingId, b.staffdeckBinding.bindingId);
    assert.equal(restored.staffdeckBinding.agentId, b.staffdeckBinding.agentId);
    const counts = dbCounts();
    for (const name of ['web', 'gateway', 'sd']) {
      await stop(name);
      if (name === 'sd') { startSD(); await ready(origin + '/api/health', 'sd'); }
      if (name === 'gateway') startGateway();
      if (name === 'web') { startWeb(); await ready(webOrigin + '/api/projects', 'web'); }
      assert.equal((await call(`/api/projects/${b.name}/staffdeck-binding/ensure`, {})).agentId, b.staffdeckBinding.agentId);
    }
    assert.deepEqual(dbCounts(), counts); return { restarts: ['web', 'gateway', 'sd'], counts };
  });
  await check('B05', 'SD outage preserves project and retry identity', async () => {
    await stop('sd');
    const failure = (await call('/api/projects/create-workspace', { workspaceType: 'new', path: join(workspace, 'ProjectFailure') })).project;
    assert.equal(failure.staffdeckBinding.status, 'failed');
    startSD(); await ready(origin + '/api/health', 'sd');
    const retry = await call(`/api/projects/${failure.name}/staffdeck-binding/ensure`, {});
    assert.equal(retry.status, 'bound'); assert.equal(retry.bindingId, failure.staffdeckBinding.bindingId);
    projects.failure = failure; return { stableBindingId: retry.bindingId };
  });
  writeFileSync(join(qa, 'projects.json'), JSON.stringify(projects, null, 2));
  console.log(`Evidence: ${qa}`);
} catch (error) {
  results.push({ id: 'L2-STARTUP', status: 'FAIL', error: error.message });
  writeFileSync(join(qa, 'results.json'), JSON.stringify({ qa, pd, sd, results }, null, 2));
  console.error(error.message); process.exitCode = 1;
} finally {
  if (!existsSync(join(qa, 'model-capture.json'))) writeFileSync(join(qa, 'model-capture.json'), JSON.stringify(capture, null, 2));
  if (!process.argv.includes('--keep')) {
    for (const name of ['web', 'gateway', 'sop', 'sd', 'model']) await stop(name);
    if (model) await new Promise(done => model.close(done));
  } else {
    for (const child of processes.values()) child.unref();
    if (model) model.unref();
    writeFileSync(join(qa, 'pids.json'), JSON.stringify(Object.fromEntries([...processes].map(([name, child]) => [name, child.pid]))));
  }
  if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
}
