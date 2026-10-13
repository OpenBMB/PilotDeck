import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa, 'Set BINDING_QA_ROOT');
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const web = `http://127.0.0.1:${env.SERVER_PORT}`;
const results = [];
async function call(operation, input, project = projects.a.name) {
  const response = await fetch(web + '/api/modules/knowledge/call', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PilotDeck-Project': project },
    body: JSON.stringify({ operation, input }) });
  const value = await response.json(); assert.ok(response.ok, `${operation}: ${JSON.stringify(value)}`); return value.result;
}
try {
  const bases = await call('list_bases', {});
  for (const scope of ['general', 'sop_specific']) {
    const base = bases.find(row => row.capability_scope === scope);
    const content = scope === 'general' ? '# Binding amber policy\n\nThe amber project verification code is AMBER_BINDING_7391.'
      : '# Binding cobalt SOP policy\n\nThe cobalt approval verification code is COBALT_SOP_8624. This knowledge is only for SOP execution.';
    const existing = await call('list_documents', { knowledgeBaseId: base.id });
    let job;
    if (!existing.some(row => row.filename === `${scope}.md`)) {
      job = await call('import_document', { knowledgeBaseId: base.id, filename: `${scope}.md`,
        contentBase64: Buffer.from(content).toString('base64'), capabilityScope: scope });
      for (let i = 0; i < 120 && !['succeeded', 'failed', 'cancelled'].includes(job.status); i++) {
        await new Promise(done => setTimeout(done, 500)); job = await call('get_job', { jobId: job.id });
      }
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
    }
    results.push({ scope, jobId: job?.id, existing: !job, status: 'PASS' });
  }
  const chat = await call('query', { query: 'amber project verification code', mode: 'chat' });
  writeFileSync(join(qa, 'knowledge-chat.json'), JSON.stringify(chat, null, 2));
  assert.ok(JSON.stringify(chat).includes('AMBER_BINDING_7391'));
  const hidden = await call('query', { query: 'cobalt approval verification code', mode: 'chat' });
  assert.ok(!JSON.stringify(hidden).includes('COBALT_SOP_8624'));
  const b = await call('query', { query: 'amber project verification code', mode: 'chat' }, projects.b.name);
  assert.ok(!JSON.stringify(b).includes('AMBER_BINDING_7391'));
  results.push({ id: 'I01', status: 'PASS', generalVisible: true, sopHiddenInChat: true, bPrivateHidden: true });
} catch (error) { results.push({ id: 'I01', status: 'FAIL', error: error.message }); process.exitCode = 1; }
writeFileSync(join(qa, 'knowledge-result.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
