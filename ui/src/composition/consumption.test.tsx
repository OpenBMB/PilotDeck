// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRenderer } from '../components/chat/tools/ToolRenderer';
import { AgentFileArtifactGroup } from '../components/chat-v2/MessageFileCards';
import MessageRowV2 from '../components/chat-v2/MessageRowV2';
import { getPermissionPanel } from '../components/chat/tools/configs/permissionPanelRegistry';
import { activateAssembly, getActiveAssembly, setActiveAssembly, validateRuntimeCapabilities } from './runtime';
import type { Assembly } from './contracts';
import { SopPermissionPanel } from './modules/staffdeck-sop';
import SopVersionDetailDialog from './modules/staffdeck/vendor/SopVersionDetailDialog';
import { SkillsPageHostProvider } from './modules/staffdeck/vendor/SkillsPageHost';
import { pilotDeckSkillsPageHost } from './modules/staffdeck/vendor/skills-host-adapter';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';
import type { NormalizedMessage } from '../stores/useSessionStore';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }) }));

afterEach(() => { cleanup(); setActiveAssembly(null); });

function assembly(overrides: Partial<Assembly> = {}): Assembly {
  return {
    selections: [], pages: [], settings: [], chatSurface: null, approvalInbox: null, chatExtensions: [], toolRenderers: [], artifactRenderers: [], permissionPanels: [], historyFallbacks: [],
    ...overrides,
  } as Assembly;
}

describe('active composition consumers', () => {
  it('accepts the deprecated knowledge frontend alias without accepting a different contract', () => {
    const binding = { enabled: true, implementationId: 'knowledge-core', frontendModule: 'knowledge-core', contract: 'knowledge-core/v1', transport: 'rest-http-v1' };
    const selected = assembly({ bindings: { knowledge: binding }, selections: [{ slot: 'knowledge', binding, frontend: { id: 'knowledge-core', slot: 'knowledge', contract: 'knowledge-core/v1' } }] } as Partial<Assembly>);
    const runtime = { modules: { knowledge: { ...binding, frontendModule: 'staffdeck.knowledge' } }, gatewayCapabilities: [] };
    expect(validateRuntimeCapabilities(selected, runtime)).toEqual([]);
    runtime.modules.knowledge.contract = 'staffdeck.knowledge/v1';
    expect(validateRuntimeCapabilities(selected, runtime)).toContain('Runtime contract differs for knowledge.');
  });
  it('renders custom tool, artifact, and historical fallback contributions', () => {
    const Tool = () => <div>custom tool rendered</div>;
    const Artifact = () => <div>custom artifact rendered</div>;
    const History = () => <div>historical module fallback rendered</div>;
    setActiveAssembly(assembly({
      toolRenderers: [{ id: 'tool', label: 'Tool', toolNames: ['remote_lookup'], component: Tool }],
      artifactRenderers: [{ id: 'artifact', label: 'Artifact', artifactMimeTypes: ['application/x-staffdeck-citation'], component: Artifact }],
      historyFallbacks: [{ moduleId: 'removed.module', contribution: { id: 'history', label: 'History', component: History } }],
    }));
    const view = render(<ToolRenderer toolName="remote_lookup" toolInput={{ q: 'x' }} mode="input" />);
    expect(screen.getByText('custom tool rendered')).toBeTruthy();
    view.unmount();
    render(<AgentFileArtifactGroup project={null} artifacts={[{ id: 'citation', name: 'citation', path: 'citation', mimeType: 'application/x-staffdeck-citation', operation: 'created', source: 'tool', status: 'complete', size: 1, sha256: 'test', createdAt: '2026-01-01T00:00:00Z' }]} />);
    expect(screen.getByText('custom artifact rendered')).toBeTruthy();
    cleanup();
    render(<MessageRowV2 message={{ id: 'old', moduleId: 'removed.module', type: 'assistant', content: 'old', timestamp: '2026-01-01T00:00:00Z' }} prevMessage={null} provider="pilotdeck" selectedProject={null} createDiff={() => []} />);
    expect(screen.getByText('historical module fallback rendered')).toBeTruthy();
  });

  it('registers permission panels and runs lifecycle cleanup', async () => {
    const Panel = () => <div />;
    const init = vi.fn(() => vi.fn());
    const dispose = vi.fn();
    const active = assembly({
      permissionPanels: [{ id: 'approval', label: 'Approval', toolNames: ['operator_approval'], component: Panel }],
      selections: [{ slot: 'sop', binding: { enabled: true }, frontend: { id: 'test.sop', slot: 'sop', contract: 'sop.lifecycle/v2', lifecycle: { init, dispose } } }],
    });
    const stop = activateAssembly(active);
    await Promise.resolve();
    expect(getActiveAssembly()).toBe(active);
    expect(getPermissionPanel('operator_approval')).toBe(Panel);
    expect(init).toHaveBeenCalledOnce();
    stop();
    expect(getPermissionPanel('operator_approval')).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps runtime-required workflow controls out of chat while the runtime is unavailable', () => {
    const Panel = () => <div />;
    const active = assembly({
      chatExtensions: [{ id: 'sop-wait', label: 'Workflow wait', requiresRuntime: true, component: Panel }],
      permissionPanels: [{ id: 'sop-approval', label: 'Workflow approval', requiresRuntime: true, toolNames: ['operator_approval'], component: Panel }],
    });
    const stop = activateAssembly(active, { modules: {}, gatewayCapabilities: [], gatewayState: 'unavailable', unavailableSlots: [] });
    expect(getActiveAssembly()?.chatExtensions).toEqual([]);
    expect(getPermissionPanel('operator_approval')).toBeNull();
    stop();
    expect(getActiveAssembly()).toBeNull();
  });

  it('keeps the newer active assembly and permission panel when an older assembly disposes', () => {
    const FirstPanel = () => <div />;
    const SecondPanel = () => <div />;
    const first = activateAssembly(assembly({
      permissionPanels: [{ id: 'first', label: 'First', toolNames: ['operator_approval'], component: FirstPanel }],
    }));
    const second = activateAssembly(assembly({
      permissionPanels: [{ id: 'second', label: 'Second', toolNames: ['operator_approval'], component: SecondPanel }],
    }));
    expect(getPermissionPanel('operator_approval')).toBe(SecondPanel);
    first();
    expect(getActiveAssembly()).not.toBeNull();
    expect(getPermissionPanel('operator_approval')).toBe(SecondPanel);
    second();
    expect(getActiveAssembly()).toBeNull();
    expect(getPermissionPanel('operator_approval')).toBeNull();
  });

  it('keeps a normalized persisted module message readable without importing its renderer', () => {
    setActiveAssembly(assembly());
    const history: NormalizedMessage[] = [{
      id: 'old', sessionId: 'history-session', provider: 'pilotdeck', kind: 'text', role: 'assistant',
      moduleId: 'removed.module', content: 'old payload', timestamp: '2026-01-01T00:00:00Z',
    }];
    const message = normalizedToChatMessages(history)[0];
    expect(message.moduleId).toBe('removed.module');
    render(<MessageRowV2 message={message} prevMessage={null} provider="pilotdeck" selectedProject={null} createDiff={() => []} />);
    expect(screen.getByTestId('removed-module-history-fallback').textContent).toContain('old payload');
  });

  it('submits SOP approval decisions through the permission callback', async () => {
    const onDecision = vi.fn();
    const view = render(<SopPermissionPanel request={{ requestId: 'approval-1', toolName: 'operator_approval' }} onDecision={onDecision} />);
    screen.getByRole('button', { name: 'sop.approve' }).click();
    expect(onDecision).toHaveBeenCalledWith('approval-1', { allow: true, message: 'sop.approved' });
    screen.getByRole('button', { name: 'sop.reject' }).click();
    expect(onDecision).toHaveBeenCalledWith('approval-1', { allow: false, message: 'sop.rejected' });
    view.unmount();
  });

  it('renders the original StaffDeck SOP version detail slice through the shared package', () => {
    const onClose = vi.fn();
    render(<SkillsPageHostProvider value={pilotDeckSkillsPageHost}><SopVersionDetailDialog detail={{
      id: 'v1', name: 'Review request', version: '3', business_domain: 'support', status: 'published',
      call_count: 4, positive_rate: 0.75, negative_rate: 0.25, updated_at: '2026-09-21T00:00:00Z',
      content: { nodes: [{ node_id: 'review', type: 'handoff' }] },
    }} onClose={onClose} /></SkillsPageHostProvider>);
    expect(screen.getByRole('dialog', { name: '版本详情：Review request / 3' })).toBeTruthy();
    expect(screen.getByText('support')).toBeTruthy();
    expect(screen.getByText(/node_id/)).toBeTruthy();
    screen.getByRole('button', { name: 'Close' }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

});
