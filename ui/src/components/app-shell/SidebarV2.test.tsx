// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

function renderSidebar(selectedProject: Project | null, extra?: Partial<ComponentProps<typeof SidebarV2>>) {
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
    ...extra,
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

    expect(screen.getByAltText('PILOTDECK')).toHaveAttribute(
      'src',
      '/pilotdeck-logo-lockup-transparent.png',
    );
    expect(screen.getByRole('navigation', { name: 'Quick actions' })).toBeTruthy();
    expect(screen.queryByText('New Chat')).toBeNull();
    expect(screen.queryByText('New Project')).toBeNull();
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

  it('shows the P mark logo when the sidebar is compact', () => {
    localStorage.setItem('sidebar-v2-width', '76');
    renderSidebar(null);

    expect(screen.queryByAltText('PILOTDECK')).toBeNull();
    const mark = document.querySelector('.brand-mark');
    expect(mark).toBeInstanceOf(HTMLImageElement);
    expect((mark as HTMLImageElement).getAttribute('src')).toBe(
      '/pilotdeck-p-mark-compact.png',
    );
  });

  it('opens scheduled tasks from the sidebar quick action', () => {
    const onSelectTab = vi.fn();
    renderSidebar(null, { onSelectTab });

    fireEvent.click(screen.getByText('Scheduled Tasks'));
    expect(onSelectTab).toHaveBeenCalledWith('cron');
  });

  it('opens skills from the sidebar quick action', () => {
    const onSelectTab = vi.fn();
    renderSidebar(null, { onSelectTab });

    fireEvent.click(screen.getByText('Skills'));
    expect(onSelectTab).toHaveBeenCalledWith('skills');
  });

  it('toggles project and conversation lists only from the chevron buttons', () => {
    const onStartNewSession = vi.fn();
    const onCreateProject = vi.fn();
    renderSidebar(general, { onStartNewSession, onCreateProject });

    const projectsHeading = screen.getByRole('button', { name: 'Collapse projects' }).closest('.tree-heading') as HTMLElement;
    const conversationsHeading = screen.getByRole('button', { name: 'Collapse conversations' }).closest('.tree-heading') as HTMLElement;

    expect(screen.getByText('PilotDeck')).toBeTruthy();
    expect(within(projectsHeading).getByRole('button', { name: 'New Project' })).toBeTruthy();
    expect(within(conversationsHeading).getByRole('button', { name: 'New Chat' })).toBeTruthy();

    fireEvent.click(screen.getByText('Projects'));
    expect(screen.getByText('PilotDeck')).toBeTruthy();
    fireEvent.click(within(projectsHeading).getByRole('button', { name: 'Collapse projects' }));
    expect(screen.queryByText('PilotDeck')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand projects' }));
    expect(screen.getByText('PilotDeck')).toBeTruthy();

    fireEvent.click(within(projectsHeading).getByRole('button', { name: 'New Project' }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Conversations'));
    expect(within(conversationsHeading).getByRole('button', { name: 'Collapse conversations' })).toBeTruthy();
    fireEvent.click(within(conversationsHeading).getByRole('button', { name: 'Collapse conversations' }));
    expect(screen.getByRole('button', { name: 'Expand conversations' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand conversations' }));
    expect(within(conversationsHeading).getByRole('button', { name: 'Collapse conversations' })).toBeTruthy();

    fireEvent.click(within(conversationsHeading).getByRole('button', { name: 'New Chat' }));
    expect(onStartNewSession).toHaveBeenCalledWith(general);
  });
});
