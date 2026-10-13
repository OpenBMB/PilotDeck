import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const env = JSON.parse(readFileSync(join(qa, 'env.json'), 'utf8'));
const credentials = JSON.parse(readFileSync(join(qa, 'credentials.json'), 'utf8'));
const projects = JSON.parse(readFileSync(join(qa, 'projects.json'), 'utf8'));
const web = `http://127.0.0.1:${env.SERVER_PORT}`, sd = env.STAFFDECK_FORMAL_API_ORIGIN;
async function native(path, body) {
  const response = await fetch(sd + path, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${credentials.admin.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function module(project, type, operation, input) {
  const response = await fetch(`${web}/api/modules/${type}/call`, { method: 'POST',
    headers: { 'X-PilotDeck-Project': project, 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value.result;
}
const results = [];
try {
  const agents = await native(`/api/enterprise/agents?tenant_id=${credentials.admin.tenantId}`);
  const global = agents.find(agent => agent.is_overall) || await native('/api/enterprise/agents', {
    tenant_id: credentials.admin.tenantId, name: 'Binding Global', is_overall: true, source_mode: 'blank' });
  const base = await native('/api/enterprise/knowledge-bases', { tenant_id: credentials.admin.tenantId,
    agent_id: global.id, name: `Global binding sync marker ${Date.now()}`, capability_scope: 'general' });
  const imported = await module(projects.a.name, 'staffdeck-copy', 'import_resources', {
    sourceAgentId: global.id, targetAgentId: projects.a.staffdeckBinding.agentId,
    resourceType: 'knowledge_base', resourceIds: [base.id] });
  assert.ok((await module(projects.a.name, 'knowledge', 'list_bases', {})).some(row => row.id === base.id));
  assert.ok(!(await module(projects.b.name, 'knowledge', 'list_bases', {})).some(row => row.id === base.id));
  const own = (await module(projects.a.name, 'knowledge', 'list_bases', {})).find(row => row.id !== base.id);
  const promoted = await native(`/api/enterprise/agents/${global.id}/resources/import`, {
    tenant_id: credentials.admin.tenantId, source_agent_id: projects.a.staffdeckBinding.agentId,
    resource_type: 'knowledge_base', resource_ids: [own.id] });
  const foreign = await fetch(`${web}/api/modules/staffdeck-copy/call`, { method: 'POST', headers: {
    'X-PilotDeck-Project': projects.b.name, 'content-type': 'application/json' }, body: JSON.stringify({
      operation: 'import_resources', input: { sourceAgentId: global.id, targetAgentId: projects.a.staffdeckBinding.agentId,
        resourceType: 'knowledge_base', resourceIds: [base.id] } }) });
  assert.equal(foreign.status, 403);
  results.push({ id: 'I03', status: 'PASS', imported, promoted, foreignTargetStatus: 403 });
  const sopId = `binding_global_sync_${Date.now()}`;
  const created = await native('/api/enterprise/skills?agent_id=' + global.id, {
    tenant_id: credentials.admin.tenantId, status: 'draft', content: { skill_id: sopId, name: 'Global SOP binding sync',
      version: '1.0.0', nodes: [{ node_id: 'answer', type: 'respond', name: 'Answer', instruction: 'Answer' }],
      edges: [], start_node_id: 'answer', terminal_node_ids: ['answer'] } });
  await native(`/api/enterprise/skills/${sopId}/publish?tenant_id=${credentials.admin.tenantId}&agent_id=${global.id}`, {});
  const sopImport = await module(projects.a.name, 'staffdeck-copy', 'import_resources', {
    sourceAgentId: global.id, targetAgentId: projects.a.staffdeckBinding.agentId, resourceType: 'skill', resourceIds: [created.id] });
  const listSop = async project => {
    const response = await fetch(`${web}/api/modules/sop/management/call`, { method: 'POST', headers: {
      'X-PilotDeck-Project': project, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'list', input: {} }) });
    assert.ok(response.ok); return (await response.json()).result.data;
  };
  assert.ok((await listSop(projects.a.name)).some(row => row.skill_id === sopId));
  assert.ok(!(await listSop(projects.b.name)).some(row => row.skill_id === sopId));
  const sopPromotion = await native(`/api/enterprise/agents/${projects.a.staffdeckBinding.agentId}/skills/${sopId}/promote-to-overall?tenant_id=${credentials.admin.tenantId}`, {});
  const wrongSop = await fetch(`${web}/api/modules/staffdeck-copy/call`, { method: 'POST', headers: {
    'X-PilotDeck-Project': projects.b.name, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'import_resources',
      input: { sourceAgentId: global.id, targetAgentId: projects.a.staffdeckBinding.agentId, resourceType: 'skill', resourceIds: [created.id] } }) });
  assert.equal(wrongSop.status, 403);
  results.push({ id: 'I03-SOP', status: 'PASS', sopImport, sopPromotion, foreignTargetStatus: 403 });
} catch (error) { results.push({ id: 'I03', status: 'FAIL', error: error.message }); process.exitCode = 1; }
writeFileSync(join(qa, 'sync-result.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
