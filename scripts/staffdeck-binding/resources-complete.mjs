import assert from 'node:assert/strict';
import { qa, env, projects, credentials, web, label, knowledge, sdk, request, python, recorder, ready } from './qa.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const report = recorder('resources-complete');
await ready(env.STAFFDECK_FORMAL_API_ORIGIN + '/api/health');
assert.equal((await request(`/api/projects/${projects.a.name}/staffdeck-binding/ensure`, {})).value.status, 'bound');
const created = await knowledge('create_base', { name: `Isolation matrix ${label}` });
assert.equal(created.status, 200, created.raw);
const ids = python('resource-fixture.py', [created.value.result.id]);
writeFileSync(join(qa, 'matrix-fixture.json'), JSON.stringify(ids));
const marker = 'A_PRIVATE_MATRIX_9351';
const moduleCases = [
  ['get_base', { knowledgeBaseId: ids.base }],
  ['update_base', { knowledgeBaseId: ids.base, description: 'matrix update' }],
  ['list_versions', { knowledgeBaseId: ids.base }],
  ['list_documents', { knowledgeBaseId: ids.base }],
  ['get_document', { documentId: ids.document }],
  ['update_document', { documentId: ids.document, title: marker + ' updated' }],
  ['list_document_buckets', { documentId: ids.document }],
  ['update_bucket', { bucketId: ids.bucket, summary: marker }],
  ['list_bucket_chunks', { bucketId: ids.bucket }],
  ['update_chunk', { chunkId: ids.chunk, content: marker }],
  ['resolve_citation', { chunkId: ids.chunk }],
  ['get_job', { jobId: ids.job }],
  ['list_okf_concepts', { knowledgeBaseId: ids.base }],
  ['upsert_okf_concept', { knowledgeBaseId: ids.base, conceptId: 'matrix.concept', contentMd: '# Matrix\n\n' + marker }],
  ['export_okf', { knowledgeBaseId: ids.base }],
  ['lint_okf', { knowledgeBaseId: ids.base }],
  ['reject_discovery', { suggestionId: ids.suggestion }],
];
for (const [operation, input] of moduleCases) await report.check('I01-MODULE-' + operation, async () => {
  const foreign = await knowledge(operation, input, projects.b.name);
  assert.equal(foreign.status, 404, foreign.raw); assert.ok(!foreign.raw.includes(marker));
  const allowed = await knowledge(operation, input); assert.equal(allowed.status, 200, allowed.raw);
  return { input, foreignStatus: foreign.status, ownerStatus: allowed.status };
});
const sdkCases = [
  ['list_knowledge_versions', { knowledgeBaseId: ids.base }],
  ['list_knowledge_documents', { knowledgeBaseId: ids.base }],
  ['get_knowledge_document', { knowledgeBaseId: ids.base, documentId: ids.document }],
  ['update_knowledge_document', { knowledgeBaseId: ids.base, documentId: ids.document, body: { title: marker } }],
  ['list_document_buckets', { documentId: ids.document }],
  ['list_bucket_chunks', { bucketId: ids.bucket }],
  ['update_knowledge_bucket', { bucketId: ids.bucket, body: { summary: marker } }],
  ['update_knowledge_chunk', { chunkId: ids.chunk, body: { content: marker } }],
  ['list_knowledge_concepts', { knowledgeBaseId: ids.base }],
  ['get_knowledge_concept', { knowledgeBaseId: ids.base, conceptId: 'matrix.concept' }],
  ['export_knowledge_okf', { knowledgeBaseId: ids.base }],
  ['get_knowledge_job', { jobId: ids.job }],
];
for (const [operation, input] of sdkCases) await report.check('I01-SDK-' + operation, async () => {
  const foreign = await sdk(operation, input, projects.b); assert.equal(foreign.status, 404, foreign.raw);
  assert.ok(!foreign.raw.includes(marker));
  let ownerInput = input;
  if (operation === 'update_knowledge_document') {
    const listed = await sdk('list_knowledge_documents', { knowledgeBaseId: ids.base });
    const rows = listed.value.data || listed.value.result?.data || listed.value.result || [];
    const current = rows.find(row => row.source_document_id === ids.document) || rows.find(row => row.title?.includes(marker));
    assert.ok(current, listed.raw);
    ownerInput = { ...input, documentId: current.id };
  }
  const allowed = await sdk(operation, ownerInput);
  assert.equal(allowed.status, 200, allowed.raw);
  return { input, foreignStatus: foreign.status, ownerStatus: allowed.status };
});
await report.check('I01-LIST-ISOLATION', async () => {
  for (const op of ['list_bases', 'list_documents', 'list_jobs', 'list_discoveries']) {
    const input = op === 'list_jobs' ? { limit: 8 } : op === 'list_documents' ? { knowledgeBaseId: ids.base }
      : op === 'list_discoveries' ? { knowledgeBaseId: ids.base } : {};
    const a = await knowledge(op, input), b = await knowledge(op, input, projects.b.name);
    assert.equal(a.status, 200, `${op}: ${a.raw}`);
    if (op === 'list_documents' || op === 'list_discoveries') assert.equal(b.status, 404, `${op}: ${b.raw}`);
    else assert.equal(b.status, 200, `${op}: ${b.raw}`);
    assert.ok(!b.raw.includes(ids.base) && !b.raw.includes(marker));
  }
  return { ownerCollectionsReadable: true, foreignPrivateRowsAbsent: true };
});
await report.check('I01-REAL-PREVIEW-JOB-EVENTS', async () => {
  const preview = await sdk('preview_generate_sop', { body: { title: 'A_PRIVATE_PREVIEW_8137', raw_content: 'Answer the user then complete' } });
  assert.equal(preview.status, 202, preview.raw);
  const jobId = preview.value.job_id;
  assert.ok(jobId);
  for (const operation of ['get_preview_job', 'cancel_preview_job']) {
    const denied = await sdk(operation, { jobId }, projects.b); assert.equal(denied.status, 404, denied.raw);
  }
  const events = project => request(`/api/modules/staffdeck-sdk/events?operation=preview_job_events&scope=agent&agentId=${project.staffdeckBinding.agentId}&jobId=${jobId}`, undefined, project.name, { timeout: 90000 });
  const denied = await events(projects.b); assert.equal(denied.status, 404, denied.raw);
  const allowed = await events(projects.a); assert.equal(allowed.status, 200, allowed.raw);
  assert.ok(allowed.raw.includes('data:'));
  const owner = await sdk('get_preview_job', { jobId }); assert.equal(owner.status, 200, owner.raw);
  const cancel = await sdk('cancel_preview_job', { jobId }); assert.equal(cancel.status, 200, cancel.raw);
  return { jobId, foreignReadCancelEvents: 404, ownerReadCancelEvents: 200,
    ownerJob: owner.value, events: allowed.raw };
});
for (const transport of ['module', 'sdk']) await report.check('I01-CANCEL-OWNER-' + transport, async () => {
  const foreign = transport === 'module' ? await knowledge('cancel_job', { jobId: ids.job }, projects.b.name)
    : await sdk('cancel_knowledge_job', { jobId: ids.job }, projects.b);
  assert.equal(foreign.status, 404, foreign.raw);
  const allowed = transport === 'module' ? await knowledge('cancel_job', { jobId: ids.job })
    : await sdk('cancel_knowledge_job', { jobId: ids.job });
  assert.equal(allowed.status, 200, allowed.raw);
  return { foreignStatus: 404, ownerStatus: 200 };
});
for (const [operation, input] of [
  ['delete_document', { documentId: ids.document }], ['delete_base', { knowledgeBaseId: ids.base }],
]) await report.check('I01-MODULE-' + operation, async () => {
  const denied = await knowledge(operation, input, projects.b.name); assert.equal(denied.status, 404, denied.raw);
  const allowed = await knowledge(operation, input); assert.equal(allowed.status, 200, allowed.raw);
  return { foreignStatus: 404, ownerStatus: 200 };
});
