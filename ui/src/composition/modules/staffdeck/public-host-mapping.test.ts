import { afterEach, expect, it, vi } from 'vitest';
import { planPublicHost, readPilotDeckModelCatalog, selectedPublicScope } from './public-host-mapping';
import { authenticatedFetch } from '../../../utils/api';
import { createPilotDeckDistillPageHost } from '../../../../plugins/staffdeck-sop/src/vendor/skills-host-adapter';
vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
it('retains selected employee/team and never defaults to a target', () => {
  expect(selectedPublicScope('/api/enterprise/tools?agent_id=other')).toEqual({ kind: 'agent', agentId: 'other' });
  expect(selectedPublicScope('/api/enterprise/tools?agent_id=')).toEqual({ kind: 'team' });
  expect(selectedPublicScope('/api/enterprise/tools', undefined, () => '')).toEqual({ kind: 'team' });
  expect(() => selectedPublicScope('/api/enterprise/tools')).toThrow('PUBLIC_SELECTED_SCOPE_REQUIRED');
});
it.each([
  ['/api/enterprise/model-configs', 'get', 'list_staffdeck_model_catalog', {}],
  ['/api/enterprise/agents/employee/skills/sop%2Fid/sync-from-overall', 'post', 'sync_sop_from_overall', { sopId: 'sop/id' }],
  ['/api/enterprise/agents/employee/skills/sop/promote-to-overall', 'post', 'promote_sop_to_overall', { sopId: 'sop' }],
  ['/api/enterprise/skills/sop/versions/v%2F1', 'delete', 'delete_sop_version', { sopId: 'sop', version: 'v/1' }],
  ['/api/enterprise/skills/jobs/preview%2Fid/cancel', 'post', 'cancel_preview_job', { jobId: 'preview/id' }],
  ['/api/enterprise/skills/sop/draft', 'post', 'move_to_draft_sop', { sopId: 'sop' }],
  ['/api/enterprise/skills/sop', 'delete', 'remove_sop', { sopId: 'sop' }],
])('maps exact path IDs %s', (path, method, operation, input) => {
  expect(planPublicHost(path, method)).toMatchObject({ operation, input });
});
it('reads the PilotDeck host catalog without converting its model IDs', async () => {
  const call = vi.fn().mockResolvedValue({ status: 200, body: { data: [{ id: 'pd-model-id', name: 'PD model', enabled: true }] } });
  const rows = await readPilotDeckModelCatalog({ call }, { kind: 'agent', agentId: 'employee' });
  expect(rows).toEqual([{ id: 'pd-model-id', name: 'PD model', enabled: true }]);
  expect(call).toHaveBeenCalledWith('list_model_catalog', {}, { signal: undefined });
});
it('preserves host catalog failures instead of falling back to StaffDeck rows', async () => {
  const call = vi.fn().mockResolvedValue({ status: 503, body: { code: 'HOST_MODEL_UNAVAILABLE' } });
  await expect(readPilotDeckModelCatalog({ call }, { kind: 'agent', agentId: 'employee' })).rejects.toMatchObject({ status: 503, code: 'HOST_MODEL_UNAVAILABLE' });
});
it('keeps dirty preview content/conversation with explicit scope and consumes real seq', async () => {
  const call = vi.mocked(authenticatedFetch);
  call.mockClear();
  call.mockResolvedValueOnce(new Response(JSON.stringify({ job_id: 'preview' }), { status: 202 }));
  call.mockResolvedValueOnce(new Response('event: chunk\ndata: {"seq":7,"content":"真实"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  const host = createPilotDeckDistillPageHost();
  const receive = vi.fn();
  const current = { skill_id: 'sop', nodes: [{ extension: true }] };
  await host.streamPost('/api/enterprise/skills/sop/rewrite/stream', { tenant_id: 'tenant', agent_id: 'other', current_skill: current, conversation: [{ role: 'user', content: 'dirty' }] }, receive);
  expect(JSON.parse(String((call.mock.calls[0][1] as RequestInit)?.body))).toEqual({ operation: 'preview_rewrite_sop', input: { sopId: 'sop', body: { current_skill: current, conversation: [{ role: 'user', content: 'dirty' }] } }, scope: { kind: 'agent', agentId: 'other' } });
  expect(receive).toHaveBeenCalledWith({ event: 'chunk', data: { seq: 7, content: '真实' } });
  expect(vi.mocked(authenticatedFetch).mock.calls.at(-1)?.[0]).toContain('operation=preview_job_events');
});
it('keeps APIJob Last-Event-ID separate from preview afterSeq and retains real SSE id', async () => {
  const { gatewayEvents } = await import('./public-host-mapping');
  const fetch = vi.mocked(authenticatedFetch); fetch.mockClear();
  fetch.mockResolvedValueOnce(new Response('id: 9\nevent: completed\ndata: {"draft_id":"real"}\n\n'));
  const receive = vi.fn();
  await gatewayEvents('job_events', 'api-job', undefined, '8', receive);
  expect(String(fetch.mock.calls[0][0])).not.toContain('scope=');
  expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { 'Last-Event-ID': '8' } });
  expect(receive).toHaveBeenCalledWith({ id: '9', event: 'completed', data: { draft_id: 'real' } });
});
it('rejects selected non-target/team draft management instead of writing to the configured target', async () => {
  const { staffDeckSopManagementClient } = await import('./clients');
  vi.spyOn(staffDeckSopManagementClient, 'status').mockResolvedValue({ enabled: true, methods: [], agentId: 'target' });
  const call = vi.spyOn(staffDeckSopManagementClient, 'call');
  const host = createPilotDeckDistillPageHost();
  await expect(host.api.get('/api/enterprise/skills/sop?agent_id=other&draft_id=original')).rejects.toThrow('PUBLIC_SCOPED_MANAGEMENT_UNAVAILABLE');
  await expect(host.api.post('/api/enterprise/skills?agent_id=', { content: { skill_id: 'sop' } })).rejects.toThrow('PUBLIC_SCOPED_MANAGEMENT_UNAVAILABLE');
  expect(call).not.toHaveBeenCalled();
});
it('uses the authenticated fixed target without clearing old selected scope and rejects explicit excluded scope', async () => {
  const { createFixedTargetContext } = await import('../../../../plugins/staffdeck-shared/vendor/copy-scope');
  const { staffDeckCopyClient } = await import('./clients');
  window.localStorage.setItem('ultrarag_enterprise_agent_scope', 'team:previous');
  vi.spyOn(staffDeckCopyClient, 'call').mockResolvedValue([
    { id: 'target', tenant_id: 'tenant', copy_target: true, is_overall: false },
    { id: 'other', tenant_id: 'tenant', copy_target: false, is_overall: false },
  ]);
  const context = createFixedTargetContext();
  await context.loadDirectory();
  expect(context.readScope()).toBe('target');
  expect(context.readTenant()).toBe('tenant');
  expect(window.localStorage.getItem('ultrarag_enterprise_agent_scope')).toBe('team:previous');
  const host = createPilotDeckDistillPageHost(context);
  const fetch = vi.mocked(authenticatedFetch); fetch.mockClear();
  await expect(host.api.get('/api/enterprise/tools?agent_id=other')).rejects.toThrow('PUBLIC_SCOPE_EXCLUDED');
  await expect(host.api.get('/api/enterprise/tools?agent_id=')).rejects.toThrow('PUBLIC_SCOPE_EXCLUDED');
  expect(fetch).not.toHaveBeenCalled();
  expect(selectedPublicScope('/api/enterprise/tools', { agent_id: undefined }, context.readScope)).toEqual({ kind: 'agent', agentId: 'target' });
  window.localStorage.removeItem('ultrarag_enterprise_agent_scope');
});
