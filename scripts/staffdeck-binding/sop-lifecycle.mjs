import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const web = `http://127.0.0.1:${env.SERVER_PORT}`, results = [];
async function call(operation, input, project = projects.a.name) {
  const response = await fetch(`${web}/api/modules/sop/management/call`, { method: 'POST',
    headers: { 'X-PilotDeck-Project': project, 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }) });
  const value = await response.json(); assert.ok(response.ok, `${operation}: ${JSON.stringify(value)}`); return value.result;
}
try {
  const sopId = `binding_lifecycle_${Date.now()}`;
  const card = { skill_id: sopId, name: 'Lifecycle QA', version: '1.0.0', description: 'Lifecycle QA',
    nodes: [{ node_id: 'answer', type: 'respond', name: 'Answer', instruction: 'Answer and complete' }],
    edges: [], start_node_id: 'answer', terminal_node_ids: ['answer'] };
  const initial = await call('create', { content: card });
  await call('publish', { sopId, draftId: initial.id });
  const versions = await call('list_versions', { sopId });
  const first = versions.data[0].version;
  const content = (await call('get_version', { sopId, version: first })).content;
  const draft = await call('create', { sopId, baseVersion: first, content: { ...content, description: 'Binding second publication' } });
  const validation = await call('validate', { sopId, draftId: draft.id }); assert.equal(validation.valid, true);
  const publication = await call('publish', { sopId, draftId: draft.id });
  assert.notEqual(publication.sop.version, first);
  const rollback = await call('rollback', { sopId, version: first });
  assert.equal(rollback.status, 'draft');
  await call('publish', { sopId, draftId: rollback.id });
  assert.equal((await call('list', {}, projects.b.name)).data.length, 0);
  const archived = await call('archive', { sopId }); assert.ok(archived);
  const response = await fetch(`${web}/api/modules/sop/definitions`, { headers: { 'X-PilotDeck-Project': projects.a.name } });
  assert.ok(!(await response.json()).definitions.some(row => (row.id ?? row.skill_id) === sopId));
  results.push({ id: 'I02-LIFECYCLE', status: 'PASS', firstVersion: first,
    secondVersion: publication.sop.version, rollback, archived });
} catch (error) { results.push({ id: 'I02-LIFECYCLE', status: 'FAIL', error: error.message }); process.exitCode = 1; }
writeFileSync(join(qa, 'sop-lifecycle-result.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
