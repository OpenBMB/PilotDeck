// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
import SidebarV2 from './SidebarV2';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('lucide-react', () => ({
  ChevronRight: () => null,
  Folder: () => null,
  GitBranch: () => null,
  MessageSquarePlus: () => null,
  Pencil: () => null,
  Trash2: () => null,
}));

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
    onStartHomeNewConversation: vi.fn(),
    onRequestDeleteProject: vi.fn(),
    onRequestDeleteSession: vi.fn(),
    onShowSettings: vi.fn(),
    ...extra,
  };

  return render(<SidebarV2 {...props} />);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SidebarV2 layout', () => {
  it('distinguishes a project load failure from an empty project list', () => {
    const onRetryLoad = vi.fn();
    renderSidebar(null, {
      projects: [],
      loadError: 'Gateway unavailable',
      onRetryLoad,
    });

    expect(screen.getByRole('status').textContent).toMatch(/temporarily unavailable|暂时无法加载/);
    expect(screen.queryByText(/No projects found|未找到项目/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Retry|重试/ }));
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it('shows brand text, quick actions, projects and conversations together', () => {
    renderSidebar(null);

    expect(screen.getByAltText('PILOTDECK').getAttribute('src')).toBe(
      '/pilotdeck-logo-lockup-transparent.png',
    );
    expect(screen.getByRole('navigation', { name: /Quick actions|Primary actions/ })).toBeTruthy();
    expect(screen.getByText(/New conversation|新对话/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start a new conversation in PilotDeck|在 PilotDeck 中新建对话/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start a general conversation|新建通用对话/ })).toBeTruthy();
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

  it('lists regular projects by lastActivity descending and excludes general', () => {
    const older: Project = {
      name: 'Users-wukai-test0806',
      displayName: 'test0806',
      fullPath: '/tmp/test0806',
      lastActivity: 1787215786943,
      sessions: [],
    };
    const newer: Project = {
      name: 'Users-wukai-test0807',
      displayName: 'test0807',
      fullPath: '/tmp/test0807',
      lastActivity: 1787570906592,
      sessions: [],
    };

    renderSidebar(newer, { projects: [general, older, newer] });

    const list = document.querySelector('.project-tree-list') as HTMLElement;
    expect(list).toBeTruthy();
    const labels = within(list)
      .getAllByText(/test080[67]/)
      .map((node) => node.textContent?.trim());
    expect(labels).toEqual(['test0807', 'test0806']);
    expect(within(list).queryByText('general')).toBeNull();
    expect(within(list).queryByText('General')).toBeNull();
  });

  it('toggles project and conversation lists only from the chevron buttons', () => {
    const onStartNewSession = vi.fn();
    renderSidebar(general, { onStartNewSession });

    const projectsHeading = screen.getByRole('button', { name: 'Collapse projects' }).closest('.tree-heading') as HTMLElement;
    const conversationsHeading = screen.getByRole('button', { name: 'Expand conversations' }).closest('.tree-heading') as HTMLElement;

    expect(screen.getByText('PilotDeck')).toBeTruthy();
    expect(within(projectsHeading).queryByRole('button', { name: 'New Project' })).toBeNull();
    expect(within(conversationsHeading).getByRole('button', { name: /Start a general conversation|新建通用对话/ })).toBeTruthy();

    fireEvent.click(screen.getByText('Projects'));
    expect(screen.getByText('PilotDeck')).toBeTruthy();
    fireEvent.click(within(projectsHeading).getByRole('button', { name: 'Collapse projects' }));
    expect(screen.queryByText('PilotDeck')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand projects' }));
    expect(screen.getByText('PilotDeck')).toBeTruthy();

    fireEvent.click(screen.getByText('Conversations'));
    expect(within(conversationsHeading).getByRole('button', { name: 'Expand conversations' })).toBeTruthy();
    fireEvent.click(within(conversationsHeading).getByRole('button', { name: 'Expand conversations' }));
    expect(screen.getByRole('button', { name: 'Collapse conversations' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversations' }));
    expect(within(conversationsHeading).getByRole('button', { name: 'Expand conversations' })).toBeTruthy();
  });

  it('starts conversations collapsed at the bottom of the sidebar', () => {
    const chattyGeneral: Project = {
      ...general,
      sessions: [{ id: 's1', title: 'hello world', lastActivity: '2026-08-01' }],
    };
    renderSidebar(chattyGeneral, { projects: [chattyGeneral, project] });

    expect(screen.getByRole('button', { name: 'Expand conversations' })).toBeTruthy();
    expect(screen.queryByText('hello world')).toBeNull();
    expect(screen.getByText('PilotDeck')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expand conversations' }));
    expect(screen.getByText('hello world')).toBeTruthy();
  });

  it('starts a home new conversation from the top-left button', () => {
    const onStartHomeNewConversation = vi.fn();
    renderSidebar(general, { onStartHomeNewConversation });

    fireEvent.click(screen.getByText(/New conversation|新对话/));
    expect(onStartHomeNewConversation).toHaveBeenCalledTimes(1);
  });

  it('starts a project or general conversation from the adjacent action', () => {
    const onStartNewSession = vi.fn();
    renderSidebar(null, { onStartNewSession });

    fireEvent.click(screen.getByRole('button', {
      name: /Start a new conversation in PilotDeck|在 PilotDeck 中新建对话/,
    }));
    expect(onStartNewSession).toHaveBeenLastCalledWith(project);

    fireEvent.click(screen.getByRole('button', {
      name: /Start a general conversation|新建通用对话/,
    }));
    expect(onStartNewSession).toHaveBeenLastCalledWith(general);
  });
});
