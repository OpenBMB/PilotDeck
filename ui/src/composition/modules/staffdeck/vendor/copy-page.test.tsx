// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SkillsPage from './SkillsPage';
import { DataTable as KnowledgeDataTable } from './SkillsPageHost';
import { PilotDeckDataTable, PilotDeckResourceImportDialog } from './business-primitives';
import { PilotDeckSkillsPageProvider, PilotDeckDistillPageProvider, pilotDeckSopDestination, createPilotDeckDistillPageHost, pilotDeckDistillPageHost, pilotDeckSkillsPageHost } from './skills-host-adapter';
import { useDistillPageHost } from './DistillPageHost';
import { staffDeckCopyClient, staffDeckSopClient, staffDeckSopManagementClient } from '../clients';

const agents = [
  { id: 'employee-real', tenant_id: 'tenant_demo', name: 'Employee', is_overall: false, active: true, copy_target: true, can_manage: true },
  { id: 'plaza-real', tenant_id: 'tenant-real', name: 'Plaza', is_overall: true, active: true, copy_target: false, can_manage: false },
];
const currentUser = { id: 'pd-user', username: 'operator', is_admin: false };

// Radix Select uses browser scrolling/pointer APIs absent from jsdom.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

beforeEach(() => {
  vi.spyOn(staffDeckSopManagementClient, 'status').mockResolvedValue({ agentId: 'employee-real' } as never);
  window.localStorage.setItem('ultrarag_enterprise_agent_scope', 'employee-real');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.removeItem('ultrarag_enterprise_agent_scope');
});

describe('PilotDeck shared plaza pages', () => {
  it('reads the explicitly selected rollback draft rather than the prior published editor snapshot', async () => {
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockResolvedValue({ id: 'rollback-new', sop_id: 'same-sop', draft_version: '1.0.1', status: 'draft', etag: 'rollback-etag', content: { skill_id: 'same-sop', name: 'Rollback content', version: '1.0.1' } } as any);
    const query = pilotDeckSkillsPageHost.editorQuery!({ skill_id: 'same-sop', draft_id: 'rollback-new', version: '1.0.1' } as any);
    expect(query).toEqual({ editor_context: 'draft:rollback-new', draft_id: 'rollback-new' });
    const host = createPilotDeckDistillPageHost();
    const selected: any = await host.api.get('/api/enterprise/skills/same-sop?draft_id=rollback-new');
    expect(call).toHaveBeenCalledExactlyOnceWith('get_draft', { sopId: 'same-sop', draftId: 'rollback-new' });
    expect(selected).toMatchObject({ name: 'Rollback content', draft_id: 'rollback-new', etag: 'rollback-etag' });
    expect(pilotDeckSkillsPageHost.editorQuery!({ version: '1.2.0' } as any)).toEqual({ editor_context: 'published:1.2.0', published_version: '1.2.0' });
  });
  it('dispatches exact version list/detail/rollback paths with their selected version and formal response', async () => {
    const published = { id: 'version-row', skill_id: 'sop/encoded', version: '1.1.0', name: 'Published', updated_at: '2026-09-27T04:00:00Z', content: { skill_id: 'sop/encoded', name: 'Published', version: '1.1.0', nodes: [] } };
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockImplementation(async (operation) => {
      if (operation === 'list_versions') return { data: [published] } as any;
      if (operation === 'get_version') return published as any;
      if (operation === 'rollback') return { id: 'rollback-draft', sop_id: 'sop/encoded', status: 'draft', draft_version: '1.1.0', updated_at: published.updated_at, content: published.content } as any;
      throw new Error(`Unexpected operation ${operation}`);
    });
    const base = '/api/enterprise/skills/sop%2Fencoded/versions';
    expect(await pilotDeckSkillsPageHost.api.get(`${base}?tenant_id=x`)).toEqual([published]);
    expect(await pilotDeckSkillsPageHost.api.get(`${base}/1.1.0?tenant_id=x&agent_id=employee-real`)).toEqual(published);
    expect(call).toHaveBeenNthCalledWith(2, 'get_version', { sopId: 'sop/encoded', version: '1.1.0' });
    const rolled: any = await pilotDeckSkillsPageHost.api.post(`${base}/1.1.0/rollback?tenant_id=x&agent_id=employee-real`);
    expect(call).toHaveBeenNthCalledWith(3, 'rollback', { sopId: 'sop/encoded', version: '1.1.0' });
    expect(rolled).toMatchObject({ skill_id: 'sop/encoded', draft_id: 'rollback-draft', version: '1.1.0', status: 'draft', content: published.content });
    await expect(pilotDeckSkillsPageHost.api.get(`${base}/1.1.0/extra?tenant_id=x`)).rejects.toThrow('Unsupported');
    expect(call).toHaveBeenCalledTimes(3);
    call.mockResolvedValue({ data: [published] } as any);
    await expect(pilotDeckSkillsPageHost.api.get(`${base}/1.1.0?tenant_id=x`)).rejects.toThrow('updated_at');
  });
  it('maps mounted editor Back to the SOP list and preserves replace/query/hash without changing target scope', async () => {
    vi.spyOn(staffDeckCopyClient, 'call').mockResolvedValue(agents as never);
    vi.spyOn(staffDeckSopManagementClient, 'call').mockResolvedValue({ data: [], drafts: [] } as never);
    window.localStorage.setItem('ultrarag_enterprise_agent_scope', 'employee-real');
    function NavigationProbe() {
      const host = useDistillPageHost();
      const location = useLocation();
      const navigate = useNavigate();
      return <><output>{location.pathname}{location.search}{location.hash}</output>
        <button onClick={() => host.navigate('/enterprise/skills?agent_id=employee-real#list', { replace: true })}>Editor Back</button>
        <button onClick={() => navigate(-1)}>History Back</button></>;
    }
    render(<MemoryRouter initialEntries={['/previous', '/sop/distill?skill_id=real']} initialIndex={1}>
      <PilotDeckDistillPageProvider><NavigationProbe /></PilotDeckDistillPageProvider>
    </MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Editor Back' }));
    expect(screen.getByRole('status').textContent).toBe('/sop?agent_id=employee-real#list');
    expect(window.localStorage.getItem('ultrarag_enterprise_agent_scope')).toBe('employee-real');
    fireEvent.click(screen.getByRole('button', { name: 'History Back' }));
    expect(screen.getByRole('status').textContent).toBe('/previous');
    expect(pilotDeckSopDestination('/enterprise/skills/distill?skill_id=x&agent_id=y#source')).toBe('/sop/distill?skill_id=x&agent_id=y#source');
    expect(pilotDeckSopDestination('/enterprise/skills')).toBe('/sop');
    expect(pilotDeckSopDestination('/enterprise/skills-other?x=1')).toBe('/enterprise/skills-other?x=1');
    expect(pilotDeckSopDestination('/knowledge?x=1')).toBe('/knowledge?x=1');
  });
  it('injects complete business primitives into Skills', () => {
    for (const host of [pilotDeckSkillsPageHost]) {
      expect(host.components?.DataTable).toBe(PilotDeckDataTable);
      expect(host.components?.ResourceImportDialog).toBe(PilotDeckResourceImportDialog);
    }
  });

  it('preserves source, target, checkbox and submit contracts in the copy dialog', () => {
    const onSourceChange = vi.fn();
    const onTargetChange = vi.fn();
    const onSelectedChange = vi.fn();
    const onSubmit = vi.fn();
    const dialog = <PilotDeckResourceImportDialog
      open title="Copy" icon={<span>icon</span>} loading={false}
      targets={[{ value: 'employee-real', label: 'Employee' }]}
      targetId="" targetPlaceholder="Select target" onTargetChange={onTargetChange}
      sources={[{ value: 'plaza-real', label: 'Plaza' }]}
      sourceId="" sourcePlaceholder="Select source" onSourceChange={onSourceChange}
      itemsLabel="Resources" items={[{ id: 'base-real', label: 'Policy' }]}
      selectedIds={[]} onSelectedChange={onSelectedChange}
      emptyText="None" note="Scope note" onClose={vi.fn()} onSubmit={onSubmit}
    />;
    const view = render(React.cloneElement(dialog, { loading: true }));

    expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '复制' })).toHaveProperty('disabled', true);
    view.rerender(dialog);

    expect(onSourceChange).toHaveBeenCalledWith('plaza-real');
    fireEvent.keyDown(screen.getByRole('combobox', { name: '复制到' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'Employee' }));
    expect(onTargetChange).toHaveBeenCalledWith('employee-real');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Policy' }));
    expect(onSelectedChange).toHaveBeenCalledWith(['base-real']);
    expect(screen.getByText('Scope note')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('selects desktop Knowledge rows through the default shared table', async () => {
    const onRowClick = vi.fn();
    const copiedBase = { id: 'copied-base', name: 'Copied policy' };
    vi.spyOn(staffDeckCopyClient, 'call').mockResolvedValue(agents as never);
    vi.spyOn(staffDeckSopManagementClient, 'call').mockResolvedValue({ data: [], drafts: [] } as never);
    render(<MemoryRouter><PilotDeckSkillsPageProvider>
      <KnowledgeDataTable
        aria-label="知识库列表"
        columns={[{ key: 'name', title: '名称', dataIndex: 'name' }]}
        data={[copiedBase]}
        rowKey={(row: typeof copiedBase) => row.id}
        onRowClick={onRowClick}
      />
    </PilotDeckSkillsPageProvider></MemoryRouter>);

    fireEvent.click(await screen.findByRole('row', { name: 'Copied policy' }));
    expect(onRowClick).toHaveBeenCalledExactlyOnceWith(copiedBase, 0);
  });

  it('selects a published SOP and submits a scoped copy request', async () => {
    const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
    vi.spyOn(staffDeckCopyClient, 'call').mockImplementation(async (operation, input = {}) => {
      calls.push({ operation, input });
      if (operation === 'list_agents') return agents as any;
      if (operation === 'list_skills') return [{ id: 'sop-real', skill_id: 'sop-real', name: 'Review', version: '1.0.0', status: 'published', updated_at: '2026-09-27' }] as any;
      if (operation === 'import_resources') return { imported: [{ id: 'sop-real' }], missing: [] } as any;
      throw new Error(`Unexpected copy operation: ${operation}`);
    });
    vi.spyOn(staffDeckSopManagementClient, 'call').mockResolvedValue({ data: [], drafts: [] } as never);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [], drafts: [] }), { status: 200 }));
    const nativeDefinitions = vi.spyOn(staffDeckSopClient, 'listDefinitions');
    render(<MemoryRouter><PilotDeckSkillsPageProvider><SkillsPage currentUser={currentUser} /></PilotDeckSkillsPageProvider></MemoryRouter>);

    fireEvent.keyDown(await screen.findByRole('button', { name: /新增/ }), { key: 'Enter' });
    fireEvent.click(await screen.findByText('从广场复制'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByText('Review'));
    fireEvent.click(within(dialog).getByRole('button', { name: /复制|确认/ }));
    expect(calls).toContainEqual({ operation: 'list_skills', input: { sourceAgentId: 'plaza-real' } });
    await waitFor(() => expect(calls).toContainEqual({ operation: 'import_resources', input: {
      targetAgentId: 'employee-real', sourceAgentId: 'plaza-real', resourceType: 'skill', resourceIds: ['sop-real'],
    } }));
    expect(nativeDefinitions).not.toHaveBeenCalled();
  });

  it('shows missing management capability without reading another SOP owner', async () => {
    vi.spyOn(staffDeckCopyClient, 'call').mockResolvedValue(agents as never);
    const error = Object.assign(new Error('StaffDeck public SOP management is not configured.'), { status: 501 });
    vi.spyOn(staffDeckSopManagementClient, 'call').mockRejectedValue(error);
    const nativeDefinitions = vi.spyOn(staffDeckSopClient, 'listDefinitions');

    render(<MemoryRouter><PilotDeckSkillsPageProvider><SkillsPage currentUser={currentUser} /></PilotDeckSkillsPageProvider></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'StaffDeck public SOP management is not configured.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(nativeDefinitions).not.toHaveBeenCalled();
  });

  it('does not use native definitions for a missing managed SOP or a failed managed save', async () => {
    const missing = vi.spyOn(staffDeckSopClient, 'listDefinitions');
    const nativeSave = vi.spyOn(staffDeckSopClient, 'saveDefinition');
    const error = Object.assign(new Error('StaffDeck public SOP management is not configured.'), { status: 501 });
    vi.spyOn(staffDeckSopManagementClient, 'call').mockImplementation(async (operation) => {
      if (operation === 'list') return { data: [{ id: 'sop-real', skill_id: 'sop-real', content: { name: 'Review' } }], drafts: [] } as never;
      throw error;
    });

    await expect(pilotDeckDistillPageHost.api.get('/api/enterprise/skills/other-sop')).rejects.toThrow('configured management owner');
    await pilotDeckDistillPageHost.api.get('/api/enterprise/skills/sop-real');
    await expect(pilotDeckDistillPageHost.api.put('/api/enterprise/skills/sop-real', { name: 'Updated review' })).rejects.toThrow('not configured');
    expect(missing).not.toHaveBeenCalled();
    expect(nativeSave).not.toHaveBeenCalled();
  });

  it('preserves each editor read precondition and never recreates a failed draft', async () => {
    let draft = { id: 'draft-one', sop_id: 'snapshot-sop', status: 'draft', etag: 'old', content: { skill_id: 'snapshot-sop', name: 'Original', description: 'Original description' } };
    const calls: string[] = [];
    vi.spyOn(staffDeckSopManagementClient, 'call').mockImplementation(async (operation, input: any) => {
      calls.push(operation);
      if (operation === 'list') return { data: [], drafts: [draft] } as never;
      if (operation === 'get_draft') return structuredClone(draft) as never;
      if (operation === 'replace_draft') {
        if (input.etag !== draft.etag) throw Object.assign(new Error('stale edit'), { status: 412 });
        draft = { ...draft, etag: 'new', content: input.content };
        return structuredClone(draft) as never;
      }
      throw new Error(`Unexpected ${operation}`);
    });
    const a = createPilotDeckDistillPageHost();
    const b = createPilotDeckDistillPageHost();
    const path = '/api/enterprise/skills/snapshot-sop';
    await a.api.get(path);
    await b.api.get(path);
    await a.api.put(path, { description: 'A latest description' });
    calls.length = 0;
    await expect(b.api.put(path, { name: 'B new name' })).rejects.toMatchObject({ status: 412 });
    expect(calls).toEqual(['replace_draft']);
    expect(draft.content.description).toBe('A latest description');
    expect(draft.content.name).toBe('Original');
    vi.mocked(staffDeckSopManagementClient.call).mockRejectedValueOnce(Object.assign(new Error('draft removed'), { status: 404 }));
    await expect(a.api.put(path, { name: 'Do not recreate' })).rejects.toMatchObject({ status: 404 });
    expect(calls).not.toContain('create');
  });

  it('restores cached content with its original read precondition after remount', async () => {
    let draft = { id: 'cached-draft', sop_id: 'cached-sop', status: 'draft', etag: 'cached-etag', content: { skill_id: 'cached-sop', name: 'Cached name', description: 'Cached description' } };
    const calls: string[] = [];
    vi.spyOn(staffDeckSopManagementClient, 'call').mockImplementation(async (operation, input: any) => {
      calls.push(operation);
      if (operation === 'list') return { data: [], drafts: [draft] } as never;
      if (operation === 'get_draft') return structuredClone(draft) as never;
      if (operation === 'replace_draft') {
        if (input.etag !== draft.etag) throw Object.assign(new Error('stale cached edit'), { status: 412 });
        draft = { ...draft, etag: 'saved-etag', content: input.content };
        return structuredClone(draft) as never;
      }
      throw new Error(`Unexpected ${operation}`);
    });
    const path = '/api/enterprise/skills/cached-sop';
    const first = createPilotDeckDistillPageHost();
    const cached = await first.api.get<any>(path);
    const remounted = createPilotDeckDistillPageHost();
    remounted.restoreEditorReadSnapshot!(cached);
    calls.length = 0;
    await remounted.api.put(path, { name: 'Reloaded name' });
    expect(calls).toEqual(['replace_draft']);
    expect(draft.content.description).toBe('Cached description');
    const staleRemount = createPilotDeckDistillPageHost();
    staleRemount.restoreEditorReadSnapshot!(cached);
    await expect(staleRemount.api.put(path, { description: 'Stale cached change' })).rejects.toMatchObject({ status: 412 });
    expect(draft.content.name).toBe('Reloaded name');
  });

  it('keeps unrelated published SOPs and reads the editable draft through get_draft', async () => {
    const operations: string[] = [];
    vi.spyOn(staffDeckSopManagementClient, 'call').mockImplementation(async (operation) => {
      operations.push(operation);
      if (operation === 'list') return {
        data: [
          { id: 'published-a', skill_id: 'published-a', name: 'Published A', version: '1.0.0', content: { skill_id: 'published-a', name: 'Published A' } },
          { id: 'published-b', skill_id: 'published-b', name: 'Published B', version: '1.0.0', content: { skill_id: 'published-b', name: 'Published B' } },
        ],
        drafts: [
          { id: 'draft-a', sop_id: 'published-a', status: 'draft', draft_version: '1.0.1', etag: 'etag-a', content: { skill_id: 'published-a', name: 'Draft A' } },
          { id: 'historical-b', sop_id: 'published-b', status: 'published', draft_version: '1.0.0', etag: 'stale', content: { skill_id: 'published-b', name: 'Stale Published Draft B' } },
        ],
      } as never;
      if (operation === 'get_draft') return { id: 'draft-a', sop_id: 'published-a', draft_version: '1.0.1', etag: 'etag-current', content: { skill_id: 'published-a', name: 'Current Draft A' } } as never;
      throw new Error(`Unexpected management operation: ${operation}`);
    });
    const nativeDefinitions = vi.spyOn(staffDeckSopClient, 'listDefinitions');

    const rows = await pilotDeckSkillsPageHost.api.get<any[]>('/api/enterprise/skills?tenant_id=pilotdeck-local');
    expect(rows.map((row) => row.skill_id)).toEqual(['published-a', 'published-b']);
    expect(rows[0].name).toBe('Draft A');
    expect(rows[1].name).toBe('Published B');
    expect(rows[1].draft_id).toBeUndefined();

    const published = await pilotDeckDistillPageHost.api.get<any>('/api/enterprise/skills/published-b');
    expect(published.name).toBe('Published B');
    expect(published.draft_id).toBeUndefined();

    const editable = await pilotDeckDistillPageHost.api.get<any>('/api/enterprise/skills/published-a');
    expect(editable.name).toBe('Current Draft A');
    expect(editable.etag).toBe('etag-current');
    expect(operations).toContain('get_draft');
    expect(nativeDefinitions).not.toHaveBeenCalled();
  });
});
