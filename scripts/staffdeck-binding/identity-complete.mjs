import assert from 'node:assert/strict';
import { projects, request, python, recorder } from './qa.mjs';
const report = recorder('identity-complete');
const a = projects.a, b = projects.b;
const { jobId } = python('job-fixture.py');
const routes = [
  ['/api/modules/knowledge/call', { operation: 'list_bases', input: {} }],
  ['/api/modules/sop/management/call', { operation: 'list', input: {} }],
  ['/api/modules/staffdeck-copy/call', { operation: 'list_agents', input: {} }],
  ['/api/modules/staffdeck-sdk/call', { operation: 'list_knowledge_bases', scope: { kind: 'agent', agentId: a.staffdeckBinding.agentId }, input: {} }],
];
for (const [route, body] of routes) {
  for (const header of ['', 'unknown-binding-project']) await report.check(`I05-MISSING-UNKNOWN-${route.split('/').at(-2)}-${header || 'missing'}`, async () => {
    const r = await request(route, { ...body, projectKey: a.fullPath, projectName: a.name }, header);
    assert.equal(r.status, 409, r.raw); return { route, header, status: r.status, error: r.value.error };
  });
  for (const fields of [{ projectKey: b.fullPath }, { projectName: b.name }, { agentId: b.staffdeckBinding.agentId }]) {
    await report.check(`I05-TRUSTED-HEADER-${route.split('/').at(-2)}-${Object.keys(fields)[0]}`, async () => {
      const baseline = await request(route, body, a.name);
      const r = await request(route, { ...body, ...fields }, a.name);
      assert.equal(r.status, baseline.status, r.raw); assert.deepEqual(r.value, baseline.value);
      return { route, fields, status: r.status, selectionFromRegisteredHeader: true };
    });
  }
}
for (const [name, body, expected] of [
  ['wrong-scope', { scope: { kind: 'agent', agentId: b.staffdeckBinding.agentId } }, 403],
  ['missing-scope', {}, 400],
  ['input-agent', { scope: { kind: 'agent', agentId: a.staffdeckBinding.agentId }, input: { agentId: b.staffdeckBinding.agentId } }, 400],
  ['input-tenant', { scope: { kind: 'agent', agentId: a.staffdeckBinding.agentId }, input: { tenant_id: 'binding-other-tenant' } }, 400],
  ['body-owner', { scope: { kind: 'agent', agentId: a.staffdeckBinding.agentId }, input: { body: { name: 'No side effect', agent_id: b.staffdeckBinding.agentId } } }, 400],
]) await report.check('I05-SDK-' + name, async () => {
  const r = await request('/api/modules/staffdeck-sdk/call', { operation: name === 'body-owner' ? 'create_knowledge_base' : 'list_knowledge_bases', input: {}, ...body }, a.name);
  assert.equal(r.status, expected, r.raw); return { status: r.status, error: r.value.error };
});
for (const operation of ['get_job', 'get_job_result', 'cancel_job', 'job_events']) await report.check('I05-FOREIGN-JOB-' + operation, async () => {
  const r = operation === 'job_events'
    ? await request(`/api/modules/staffdeck-sdk/events?operation=${operation}&jobId=${jobId}&projectKey=${encodeURIComponent(a.fullPath)}`, undefined, b.name)
    : await request('/api/modules/staffdeck-sdk/call', { operation, projectKey: a.fullPath, input: { jobId } }, b.name);
  assert.equal(r.status, 403, r.raw); assert.ok(!r.raw.includes('A_PRIVATE'));
  return { status: r.status, jobId, error: r.value.error };
});
await report.check('I05-ENSURE-ROUTE-AUTHORITY', async () => {
  const r = await request(`/api/projects/${a.name}/staffdeck-binding/ensure`, { projectKey: b.fullPath, agentId: b.staffdeckBinding.agentId }, b.name);
  assert.equal(r.status, 200); assert.equal(r.value.agentId, a.staffdeckBinding.agentId);
  const unknown = await request('/api/projects/unknown-binding-project/staffdeck-binding/ensure', { projectKey: a.fullPath }, a.name);
  assert.equal(unknown.status, 404);
  return { routeAgentId: r.value.agentId, unknownStatus: 404 };
});
