import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const scripts = dirname(fileURLToPath(import.meta.url)), pd = resolve(scripts, '../..');
const sd = process.env.STAFFDECK_CHECKOUT || resolve(pd, '../StaffDeck'), qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const env = JSON.parse(readFileSync(join(qa, 'env.json'))), projects = JSON.parse(readFileSync(join(qa, 'projects.json')));
const value = spawnSync(process.env.BINDING_QA_PYTHON, [join(scripts, 'job-fixture.py')], { cwd: sd,
  env: { ...process.env, PYTHONPATH: `${sd}/backend:${sd}/backend/src`, DATABASE_URL: `sqlite:///${qa}/sd.sqlite` }, encoding: 'utf8' });
assert.equal(value.status, 0, value.stderr); const { jobId } = JSON.parse(value.stdout);
const web = `http://127.0.0.1:${env.SERVER_PORT}`, results = [], started = Date.now();
try {
  for (const operation of ['get_job', 'get_job_result', 'cancel_job', 'job_events']) {
    const stream = operation === 'job_events';
    const request = project => fetch(web + '/api/modules/staffdeck-sdk/' + (stream ? `events?operation=job_events&jobId=${jobId}` : 'call'), {
      method: stream ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'X-PilotDeck-Project': project },
      body: stream ? undefined : JSON.stringify({ operation, input: { jobId } }), signal: AbortSignal.timeout(10000) });
    const denied = await request(projects.b.name); assert.equal(denied.status, 403, operation);
    assert.ok(!(await denied.text()).includes('A_PRIVATE'));
    if (operation !== 'cancel_job') {
      const allowed = await request(projects.a.name); assert.equal(allowed.status, 200, operation);
      const body = await allowed.text();
      if (operation !== 'get_job') assert.ok(body.includes('A_PRIVATE'), operation);
    }
  }
  for (const project of ['', 'unknown-binding-project']) {
    const response = await fetch(web + '/api/modules/knowledge/call', { method: 'POST', headers: {
      'content-type': 'application/json', ...(project ? { 'X-PilotDeck-Project': project } : {}) },
      body: JSON.stringify({ operation: 'list_bases', input: {} }) });
    assert.equal(response.status, 409);
  }
  results.push({ id: 'I01/I05-JOBS', status: 'PASS', jobId, readsResultsCancelEventsDenied: true,
    rightfulEventsVisible: true, unknownMissingProjectDenied: true, elapsedMs: Date.now() - started });
} catch (error) { results.push({ id: 'I01/I05-JOBS', status: 'FAIL', error: error.message, elapsedMs: Date.now() - started }); process.exitCode = 1; }
writeFileSync(join(qa, 'jobs-result.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
