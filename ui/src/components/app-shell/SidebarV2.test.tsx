// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
import type { AgentGroup } from '../../types/group';
import SidebarV2 from './SidebarV2';

const general: Project = {
  name: 'general',
  displayName: 'general',
  fullPath: '/workspace/general',
  sessions: [],
};

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
  sessions: [],
};

const now = '2026-08-01T12:00:00.000Z';

function group(overrides: Partial<AgentGroup>): AgentGroup {
  return {
    id: 'group-1',
    title: 'Architecture room',
    projectName: 'pilotdeck',
    projectPath: '/workspace/PilotDeck',
    triggerMode: 'auto',
    muted: false,
    status: 'active',
    unreadCount: 0,
    hasSilentUnread: false,
    lastMessagePreview: 'Main agent summary',
    members: [{
      id: 'main',
      roomId: 'group-1',
      kind: 'pilotdeck_main',
      name: 'PilotDeck Main',
      position: 10_000,
      config: {},
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function renderSidebar(selectedProject: Project | null, groups: AgentGroup[] = []) {
  const props: ComponentProps<typeof SidebarV2> = {
    projects: [general, project],
    groups,
    selectedProject,
    selectedSession: null,
    activeTab: 'chat',
    isLoading: false,
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onCreateProject: vi.fn(),
    onSelectGroup: vi.fn(),
    onCreateGroup: vi.fn(),
    onOpenGroups: vi.fn(),
    onRequestDeleteProject: vi.fn(),
    onRequestDeleteSession: vi.fn(),
    onShowSettings: vi.fn(),
  };

  return {
    ...render(
      <MemoryRouter>
        <SidebarV2 {...props} />
      </MemoryRouter>,
    ),
    props,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SidebarV2 default section', () => {
  it('starts on Projects even when an old General preference remains in storage', () => {
    localStorage.setItem('sidebar-v2-active-section', 'general');
    renderSidebar(null);

    expect(screen.getByRole('tab', { name: 'Projects' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('false');
  });

  it('still shows General when an explicit General project is selected', async () => {
    renderSidebar(general);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    });
  });

  it('shows first-class groups and suppresses the bright unread badge for muted groups', async () => {
    const active = group({ unreadCount: 2 });
    const muted = group({
      id: 'group-2',
      title: 'Quiet review room',
      muted: true,
      unreadCount: 7,
      hasSilentUnread: true,
    });
    const { props } = renderSidebar(null, [active, muted]);

    fireEvent.click(screen.getByRole('tab', { name: 'Groups' }));

    expect(props.onOpenGroups).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Architecture room')).toBeTruthy();
    expect(screen.getByText('Quiet review room')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByText('7')).toBeNull();
  });
});
