import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPilotDeckDistillPageHost, pilotDeckSkillsPageHost } from './skills-host-adapter';
import { staffDeckSopManagementClient } from '../../../../src/composition/modules/staffdeck/clients';

const content = { skill_id: 'sop', name: 'Original', version: 'old-content-version', nodes: [{ node_id: 'n', extension: { keep: true } }], edges: [], extension: { preserved: true } };
const draft = (id: string, updated: string) => ({ id, sop_id: 'sop', draft_version: '1.2.3', status: 'draft', updated_at: updated, content, etag: `"${id}"` });
afterEach(() => vi.restoreAllMocks());

describe('PilotDeck SOP editor lifecycle', () => {
  it('uses the selected publication as first-edit base independently of editable content version', async () => {
    const call = vi.spyOn(staffDeckSopManagementClient, 'call')
      .mockResolvedValueOnce({ id: 'published', version: '2.3.4', status: 'published', content: { ...content, version: '2.3.4' } })
      .mockResolvedValueOnce({ ...draft('first-edit', ''), draft_version: '2.3.5' });
    const host = createPilotDeckDistillPageHost();
    await host.api.get('/api/enterprise/skills/sop?published_version=2.3.4');
    await host.api.put('/api/enterprise/skills/sop', { name: 'Reviewed', version: '99.0.0' });
    expect(call.mock.calls[1][1]).toMatchObject({ sopId: 'sop', baseVersion: '2.3.4', content: { version: '99.0.0', name: 'Reviewed' } });
    expect(call.mock.calls.map(([operation]) => operation)).toEqual(['get_version', 'create']);
  });
  it('projects the first create and replaces that same draft with its original ETag', async () => {
    const created = draft('new-draft', '2026-09-27T01:00:00Z');
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockResolvedValue(created);
    const host = createPilotDeckDistillPageHost();
    const read: any = await host.api.post('/api/enterprise/skills?tenant_id=tenant', content);
    expect(read).toMatchObject({ id: 'new-draft', skill_id: 'sop', draft_id: 'new-draft', etag: '"new-draft"', version: '1.2.3', content });
    await host.api.put('/api/enterprise/skills/sop?tenant_id=tenant', { name: 'Changed' });
    expect(call.mock.calls.map(([op]) => op)).toEqual(['create', 'replace_draft']);
    expect(call.mock.calls[1][1]).toEqual({ sopId: 'sop', draftId: 'new-draft', etag: '"new-draft"', content: { ...content, name: 'Changed' } });
  });
  it('preserves every actual draft row for explicit selection, independent of response order or dates', async () => {
    const latest = draft('latest', '2026-09-27T02:00:00Z');
    const earlier = draft('earlier', '2026-09-26T02:00:00Z');
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockResolvedValue({ data: [], drafts: [latest, earlier] });
    const rows: any = await pilotDeckSkillsPageHost.api.get('/api/enterprise/skills?tenant_id=tenant');
    expect(rows.map((row: any) => ({ id: row.id, draft_id: row.draft_id, date: row.updated_at }))).toEqual([
      { id: 'latest', draft_id: 'latest', date: latest.updated_at },
      { id: 'earlier', draft_id: 'earlier', date: earlier.updated_at },
    ]);
    expect(pilotDeckSkillsPageHost.editorQuery!(rows[1])).toMatchObject({ draft_id: 'earlier' });
    await expect(pilotDeckSkillsPageHost.api.post('/api/enterprise/skills/sop/publish')).rejects.toThrow('explicit draft_id');
    expect(call.mock.calls.map(([op]) => op)).toEqual(['list', 'list']);
    call.mockResolvedValueOnce(earlier).mockResolvedValueOnce({ sop: { id: 'sop' } });
    await pilotDeckSkillsPageHost.api.post('/api/enterprise/skills/sop/publish?draft_id=earlier');
    expect(call.mock.calls.at(-1)?.slice(0, 2)).toEqual(['publish', { sopId: 'sop', draftId: 'earlier' }]);
    call.mockResolvedValue({ data: [], drafts: [earlier, latest] });
    const reversed: any = await pilotDeckSkillsPageHost.api.get('/api/enterprise/skills');
    expect(reversed.map((row: any) => row.draft_id)).toEqual(['earlier', 'latest']);
    call.mockResolvedValue({ data: [] });
    await expect(pilotDeckSkillsPageHost.api.get('/api/enterprise/skills')).rejects.toThrow('data and drafts');
  });
  it('preserves owner row ID independently from the SOP identity used for requests', async () => {
    const ownerRow = { id: 'owner-row', skill_id: 'sop', name: 'Published', version: '1.2.3', updated_at: '2026-09-27T01:00:00Z', content };
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockResolvedValue({ data: [ownerRow], drafts: [] });
    const rows: any = await pilotDeckSkillsPageHost.api.get('/api/enterprise/skills');
    expect(rows[0]).toMatchObject({ id: 'owner-row', skill_id: 'sop' });
    call.mockResolvedValue(ownerRow);
    const host = createPilotDeckDistillPageHost();
    expect(await host.api.get('/api/enterprise/skills/sop?published_version=1.2.3')).toMatchObject({ id: 'owner-row', skill_id: 'sop' });
    expect(call.mock.calls[1]).toEqual(['get_version', { sopId: 'sop', version: '1.2.3' }]);
  });
  it('rejects missing row IDs for list, first create and direct published-version reads', async () => {
    const malformed = { skill_id: 'sop', version: '1.2.3', content };
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockResolvedValue({ data: [malformed], drafts: [] });
    await expect(pilotDeckSkillsPageHost.api.get('/api/enterprise/skills')).rejects.toThrow('formal row ID');
    call.mockResolvedValue(malformed);
    const host = createPilotDeckDistillPageHost();
    await expect(host.api.post('/api/enterprise/skills', content)).rejects.toThrow('formal row ID');
    await expect(host.api.get('/api/enterprise/skills/sop?published_version=1.2.3')).rejects.toThrow('formal row ID');
    expect(call.mock.calls.map(([operation]) => operation)).toEqual(['list', 'create', 'get_version']);
  });
  it('restores dirty original lifecycle and never advances its ETag after a conflict', async () => {
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockRejectedValue(Object.assign(new Error('conflict'), { status: 412 }));
    const host = createPilotDeckDistillPageHost();
    host.restoreEditorReadSnapshot!({ id: 'sop', skill_id: 'sop', name: 'Dirty', version: '1.2.3', draft_id: 'original', etag: '"original"', content });
    await expect(host.api.put('/api/enterprise/skills/sop', { name: 'Dirty' })).rejects.toMatchObject({ status: 412 });
    expect(call.mock.calls[0][1]).toMatchObject({ draftId: 'original', etag: '"original"', content: { ...content, name: 'Dirty' } });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('forwards real AbortSignal for reads and creates and refuses an already aborted request', async () => {
    const controller = new AbortController();
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockResolvedValue(draft('selected', '2026-09-27T01:00:00Z'));
    const host = createPilotDeckDistillPageHost();
    await host.api.get('/api/enterprise/skills/sop?draft_id=selected', { signal: controller.signal });
    expect(call.mock.calls[0]).toEqual(['get_draft', { sopId: 'sop', draftId: 'selected' }, { signal: controller.signal }]);
    await host.api.postWithSignal('/api/enterprise/skills', content, controller.signal);
    expect(call.mock.calls[1][2]).toEqual({ signal: controller.signal });
    controller.abort();
    await expect(host.api.get('/api/enterprise/skills/sop', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('isolates snapshots between mounted editor host instances and rejects adjacent paths', async () => {
    const first = createPilotDeckDistillPageHost();
    const second = createPilotDeckDistillPageHost();
    first.restoreEditorReadSnapshot!({ id: 'sop', skill_id: 'sop', name: 'Original', version: '1', draft_id: 'original', etag: '"original"', content });
    await expect(second.api.put('/api/enterprise/skills/sop', {})).rejects.toThrow('snapshot is unavailable');
    const call = vi.spyOn(staffDeckSopManagementClient, 'call');
    await expect(first.api.get('/api/enterprise/skills/sop/unknown')).rejects.toThrow('Unsupported');
    expect(call).not.toHaveBeenCalled();
  });
});

describe('mounted copy context isolation', () => {
  it('retains each mounted target when another provider loads a different visible directory', async () => {
    const { createCopyContext } = await import('../../../staffdeck-shared/vendor/copy-scope');
    const { staffDeckCopyClient } = await import('../../../../src/composition/modules/staffdeck/clients');
    window.localStorage.clear();
    const call = vi.spyOn(staffDeckCopyClient, 'call');
    const first = createCopyContext();
    const second = createCopyContext();
    call.mockResolvedValue([{ id: 'a', tenant_id: 'tenant-a', copy_target: true, is_overall: false }] as never);
    await first.loadDirectory();
    call.mockResolvedValue([{ id: 'b', tenant_id: 'tenant-b', copy_target: true, is_overall: false }] as never);
    await second.loadDirectory();
    expect(first.readScope()).toBe('a');
    expect(second.readScope()).toBe('b');
    expect(first.readTenant()).toBe('tenant-a');
    expect(second.readTenant()).toBe('tenant-b');
    expect(first.isTarget({ id: 'a' })).toBe(true);
    expect(first.isTarget({ id: 'b' })).toBe(false);
    window.localStorage.clear();
  });
});

describe('editor provider bootstrap', () => {
  it('does not mount an editor while management is missing', async () => {
    const { render, screen, cleanup } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { PilotDeckDistillPageProvider } = await import('./skills-host-adapter');
    const { staffDeckCopyClient } = await import('../../../../src/composition/modules/staffdeck/clients');
    vi.spyOn(staffDeckCopyClient, 'call').mockResolvedValue([{ id: 'target', tenant_id: 'tenant-real', copy_target: true, is_overall: false }] as never);
    vi.spyOn(staffDeckSopManagementClient, 'call').mockRejectedValue(Object.assign(new Error('Management is missing'), { status: 501 }));
    try {
      render(<MemoryRouter><PilotDeckDistillPageProvider><div>Editor content</div></PilotDeckDistillPageProvider></MemoryRouter>);
      expect((await screen.findByRole('alert')).textContent).toBe('Management is missing');
      expect(screen.queryByText('Editor content')).toBeNull();
    } finally { cleanup(); }
  });
  it('aborts its pending bootstrap and cannot continue into management after unmount', async () => {
    const { render, cleanup } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const { PilotDeckDistillPageProvider } = await import('./skills-host-adapter');
    const { staffDeckCopyClient } = await import('../../../../src/composition/modules/staffdeck/clients');
    let signal: AbortSignal | undefined;
    vi.spyOn(staffDeckCopyClient, 'call').mockImplementation((_operation, _input, options) => new Promise((_resolve, reject) => {
      signal = options?.signal;
      signal?.addEventListener('abort', () => reject(signal!.reason));
    }));
    const management = vi.spyOn(staffDeckSopManagementClient, 'call');
    const view = render(<MemoryRouter><PilotDeckDistillPageProvider><div>Editor content</div></PilotDeckDistillPageProvider></MemoryRouter>);
    view.unmount();
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(management).not.toHaveBeenCalled();
    cleanup();
  });
});
