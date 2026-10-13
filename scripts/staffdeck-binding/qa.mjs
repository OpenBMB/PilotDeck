import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const qa = process.env.BINDING_QA_ROOT;
assert.ok(qa, 'Set BINDING_QA_ROOT to an isolated acceptance environment');
export const envPath = join(qa, 'env.json');
export const env = JSON.parse(readFileSync(envPath, 'utf8'));
export const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
export const credentials = JSON.parse(readFileSync(join(qa, 'credentials.json'), 'utf8'));
export const web = `http://127.0.0.1:${env.SERVER_PORT}`;
assert.equal(new URL(env.STAFFDECK_FORMAL_API_ORIGIN).hostname, '127.0.0.1');
export const label = process.env.BINDING_QA_RUN_LABEL || String(Date.now());
assert.match(label, /^[a-zA-Z0-9_-]+$/);
export function restart(...names) {
  const r = spawnSync(process.execPath, [join(pd, 'scripts/staffdeck-binding/restart.mjs'), ...names], {
    cwd: pd, env: { ...process.env, BINDING_QA_ROOT: qa, NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
export async function ready(url = web + '/api/projects') {
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Isolated service unavailable: ' + url);
}
export async function request(path, body, project = projects.a.name, options = {}) {
  const response = await fetch(web + path, { method: options.method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(project ? { 'X-PilotDeck-Project': project } : {}), ...options.headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(options.timeout || 45000) });
  const raw = await response.text();
  let value; try { value = JSON.parse(raw); } catch { value = raw; }
  return { status: response.status, value, raw };
}
export async function knowledge(operation, input = {}, project = projects.a.name) {
  return request('/api/modules/knowledge/call', { operation, input }, project);
}
export async function sdk(operation, input = {}, project = projects.a, extras = {}) {
  return request('/api/modules/staffdeck-sdk/call', { operation,
    scope: { kind: 'agent', agentId: project.staffdeckBinding.agentId }, input, ...extras }, project.name);
}
export function python(file, args = []) {
  const sd = process.env.STAFFDECK_CHECKOUT || resolve(pd, '../StaffDeck');
  const r = spawnSync(process.env.BINDING_QA_PYTHON || env.BINDING_QA_PYTHON,
    [join(pd, 'scripts/staffdeck-binding', file), ...args], { cwd: sd,
      env: { ...process.env, BINDING_QA_ROOT: qa, DATABASE_URL: `sqlite:///${qa}/sd.sqlite`,
        PYTHONPATH: `${sd}/backend:${sd}/backend/src`, APP_SECRET: 'binding-isolated-acceptance-secret', NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
export function recorder(name) {
  const results = [], path = join(qa, `${name}-result-${label}.json`);
  return { results, async check(id, action) {
    const start = Date.now();
    try { results.push({ id, status: 'PASS', evidence: await action(), elapsedMs: Date.now() - start }); }
    catch (error) { results.push({ id, status: 'FAIL', error: error.message, elapsedMs: Date.now() - start }); process.exitCode = 1; }
    writeFileSync(path, JSON.stringify({ command: process.argv.slice(1), results }, null, 2));
    console.log(results.at(-1).status, id);
  } };
}
