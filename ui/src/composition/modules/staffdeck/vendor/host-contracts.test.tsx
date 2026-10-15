// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { pilotDeckSkillsPageHost, createPilotDeckDistillPageHost } from './skills-host-adapter';
import { staffDeckSopManagementClient } from '../clients';
import { pilotDeckFormalComponents } from './host-components';
import { renderMarkdownBlocks } from './FormalMarkdown';
import { normalizeCapabilityScope } from './FormalCapabilityScopeControl';
import { formatHandoffAssigneeValue, parseHandoffAssigneeValue } from './FormalHandoff';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('formal Host audit regressions', () => {
  it('does not let an editor unknown suffix become a detail read or save', async () => {
    const call = vi.spyOn(staffDeckSopManagementClient, 'call');
    const host = createPilotDeckDistillPageHost();
    await expect(host.api.get('/api/enterprise/skills/sop/unknown')).rejects.toThrow('Unsupported');
    await expect(host.api.put('/api/enterprise/skills/sop/unknown', {})).rejects.toThrow('Unsupported');
    expect(call).not.toHaveBeenCalled();
  });
  it('creates the first edited draft and dispatches move-to-draft through the selected public owner', async () => {
    const content = { skill_id: 'sop', name: 'Original', version: '1.0.0', nodes: [{ node_id: 'start' }], extensions: { preserved: true } };
    const call = vi.spyOn(staffDeckSopManagementClient, 'call').mockImplementation(async operation => operation === 'list' ? { data: [{ id: 'sop', skill_id: 'sop', status: 'published', content }], drafts: [] } as any : { id: 'new-draft', sop_id: 'sop', content, draft_version: '1.0.1', etag: 'first-read' } as any);
    vi.spyOn(staffDeckSopManagementClient, 'status').mockResolvedValue({ agentId: 'target' } as any);
    const host = createPilotDeckDistillPageHost();
    await host.api.get('/api/enterprise/skills/sop?agent_id=target');
    await host.api.put('/api/enterprise/skills/sop?agent_id=target', content);
    expect(call).toHaveBeenLastCalledWith('create', { sopId: 'sop', content, baseVersion: '1.0.0' });
    const requests = call.mock.calls.length;
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { id: 'owner-draft' } })));
    await pilotDeckSkillsPageHost.api.post('/api/enterprise/skills/sop/draft?agent_id=target');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ operation: 'move_to_draft_sop', input: { sopId: 'sop' }, scope: { kind: 'agent', agentId: 'target' } });
    expect(call).toHaveBeenCalledTimes(requests);
  });
  it('preserves formal markdown blocks and pure scope/handoff contracts', () => {
    render(<article>{renderMarkdownBlocks('# Title\n\n**Fact**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')}</article>);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByText('Fact').tagName).toBe('STRONG');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(normalizeCapabilityScope('sop-specific')).toBe('sop_specific');
    expect(normalizeCapabilityScope('unknown')).toBe('general');
    expect(formatHandoffAssigneeValue('user', 'web')).toBe('user');
    expect(parseHandoffAssigneeValue(' user ')).toEqual({ userId: 'user', channel: 'web' });
  });
  it('keeps the original loading confirmation open and blocks Cancel/Confirm until loading completes', async () => {
    const Confirm = pilotDeckFormalComponents.ConfirmDialog;
    const close = vi.fn(); const confirm = vi.fn();
    render(<Confirm open loading title="Delete original item" onOpenChange={close} onConfirm={confirm} />);
    expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '删除' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(close).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
});
