// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
});
