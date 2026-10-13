import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url)), pd = resolve(scripts, '../..');
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa, 'Set BINDING_QA_ROOT from run.mjs output');
const home = mkdtempSync(join(qa, 'concurrency-home-'));
const label = process.env.BINDING_QA_RUN_LABEL || String(Date.now());
assert.match(label, /^[a-zA-Z0-9_-]+$/);
writeFileSync(join(home, 'pilotdeck.yaml'), readFileSync(join(qa, 'home/pilotdeck.yaml')), { mode: 0o600 });
const env = { ...process.env }; delete env.NODE_OPTIONS;
const results = [];
const store = () => JSON.parse(readFileSync(join(home, 'staffdeck/project-bindings.json'), 'utf8'));
function worker(project, phase = 'normal') {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(scripts, 'worker.mjs'), pd, home, project, phase], { env });
    let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (phase === 'normal' && code !== 0) reject(new Error(error));
      else done({ code, signal, value: output.trim() ? JSON.parse(output.trim().split('\n').at(-1)) : undefined });
    });
  });
}
async function counts() {
  const credentials = JSON.parse(readFileSync(join(qa, 'credentials.json'), 'utf8'));
  const configured = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
  const response = await fetch(`${configured.STAFFDECK_FORMAL_API_ORIGIN}/api/enterprise/agents?tenant_id=${credentials.admin.tenantId}`, {
    headers: { authorization: `Bearer ${credentials.admin.token}` } });
  assert.ok(response.ok);
  const value = await response.json();
  // The public list truncates at 50/100 and has no cursor; the native list is complete.
  const result = spawnSync(process.env.BINDING_QA_PYTHON, [join(scripts, 'counts.py')], {
    env: { ...env, DATABASE_URL: `sqlite:///${join(qa, 'sd.sqlite')}` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { apiAgents: value.data?.length ?? value.length, ...JSON.parse(result.stdout) };
}
function assertAdded(before, after, amount) {
  for (const key of ['apiAgents', 'agents', 'mappings']) assert.equal(after[key], before[key] + amount, key);
}
async function check(name, action) {
  const started = Date.now();
  try { const evidence = await action(); results.push({ name, status: 'PASS', elapsedMs: Date.now() - started, evidence }); }
  catch (error) { results.push({ name, status: 'FAIL', elapsedMs: Date.now() - started, error: error.message }); }
  writeFileSync(join(qa, `concurrency-result-${label}.json`), JSON.stringify(results, null, 2));
  console.log(results.at(-1).status, name);
}
await check('B03 three processes same project', async () => {
  const project = join(home, 'concurrent-same');
  const before = await counts();
  const values = await Promise.all(Array.from({ length: 3 }, () => worker(project)));
  assert.ok(values.every(result => result.value.status === 'bound'));
  assert.equal(new Set(values.map(result => result.value.agentId)).size, 1);
  assert.equal(store().projects.length, 1);
  const after = await counts(); assertAdded(before, after, 1);
  return { processes: 3, requestsPerProcess: 20, requests: 60, agentId: values[0].value.agentId, before, after, pdRecords: 1 };
});
await check('B03 ten projects concurrent, three rounds', async () => {
  const before = await counts(), projects = Array.from({ length: 10 }, (_, i) => join(home, `parallel-${i}`));
  const ids = new Map(), rounds = [];
  for (let round = 0; round < 3; round++) {
    const values = await Promise.all(projects.map(project => worker(project)));
    assert.ok(values.every(result => result.value.status === 'bound'));
    values.forEach((result, index) => {
      if (ids.has(index)) assert.equal(result.value.agentId, ids.get(index));
      ids.set(index, result.value.agentId);
    });
    const after = await counts(); assertAdded(before, after, 10);
    assert.equal(store().projects.length, 11);
    rounds.push({ round: round + 1, ...after, pdRecords: store().projects.length });
  }
  assert.equal(new Set(ids.values()).size, 10);
  assert.equal(store().projects.length, 11);
  return { projects: 10, before, rounds, records: store().projects.length };
});
for (const phase of ['uuid', 'before-commit', 'after-commit', 'activation', 'after-activation']) {
  await check(`B03 interrupt ${phase}`, async () => {
    const before = await counts(), project = join(home, `crash-${phase}`);
    const killed = await worker(project, phase); assert.equal(killed.signal, 'SIGKILL');
    const binding = store().projects.find(row => row.projectRoot === project);
    assert.ok(binding.bindingId);
    const restored = (await worker(project)).value;
    assert.equal(restored.status, 'bound'); assert.equal(restored.bindingId, binding.bindingId);
    if (binding.agentId) assert.equal(restored.agentId, binding.agentId);
    const after = await counts(); assertAdded(before, after, 1);
    assert.equal(store().projects.filter(row => row.projectRoot === project).length, 1);
    return { phase, stableBindingId: restored.bindingId, agentId: restored.agentId, before, after, pdRecords: store().projects.length };
  });
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
