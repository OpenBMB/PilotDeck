// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
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

function renderSidebar(selectedProject: Project | null) {
  const props: ComponentProps<typeof SidebarV2> = {
    projects: [general, project],
    selectedProject,
    selectedSession: null,
    activeTab: 'chat',
    isLoading: false,
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onCreateProject: vi.fn(),
    onRequestDeleteProject: vi.fn(),
    onRequestDeleteSession: vi.fn(),
    onShowSettings: vi.fn(),
  };

  return render(
    <MemoryRouter>
      <SidebarV2 {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SidebarV2 layout', () => {
  it('shows brand text, quick actions, projects and conversations together', () => {
    renderSidebar(null);

    expect(screen.getByText('PILOTDECK')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Quick actions' })).toBeTruthy();
    expect(screen.getByText('New Chat')).toBeTruthy();
    expect(screen.getByText('Skills')).toBeTruthy();
    expect(screen.getByText('Scheduled Tasks')).toBeTruthy();
    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('Conversations')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
  });

  it('keeps both projects and conversations visible when general is selected', () => {
    renderSidebar(general);

    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('Conversations')).toBeTruthy();
    expect(screen.getByText('PilotDeck')).toBeTruthy();
  });
});
