// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within, waitFor, type RenderOptions } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../i18n/testInstance';
import enSidebar from '../../i18n/locales/en/sidebar.json';
import zhSidebar from '../../i18n/locales/zh-CN/sidebar.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
import SidebarV2 from './SidebarV2';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('lucide-react', () => ({
  ChevronRight: () => null,
  Loader2: () => <svg data-testid="running-indicator" />,
  Folder: () => null,
  GitBranch: () => null,
  MessageSquarePlus: () => null,
  Plus: () => null,
  Pencil: () => null,
  PanelLeftOpen: () => null,
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

function renderSidebar(selectedProject: Project | null, extra?: Partial<ComponentProps<typeof SidebarV2>>, options?: RenderOptions) {
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
    onCreateProject: vi.fn(),
    onRequestDeleteProject: vi.fn(),
    onRequestDeleteSession: vi.fn(),
    onShowSettings: vi.fn(),
    ...extra,
  };

  return render(<SidebarV2 {...props} />, options);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.pilotdeckDesktop;
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

    const brand = screen.getByRole('img', { name: 'PILOTDECK' });
    const brandSources = Array.from(brand.querySelectorAll('img')).map((image) =>
      image.getAttribute('src'),
    );
    expect(brandSources).toHaveLength(2);
    expect(brandSources[0]).toContain('pilotdeck-wordmark-light.png');
    expect(brandSources[1]).toContain('pilotdeck-wordmark-dark.png');
    expect(screen.getByRole('navigation', { name: /Quick actions|Primary actions/ })).toBeTruthy();
    expect(screen.getByText(/New conversation|新对话/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start a new conversation in PilotDeck|在 PilotDeck 中新建对话/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start a general conversation|新建通用对话/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create new project|创建新项目/ })).toBeTruthy();
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

  it('keeps a sidebar expansion control when the wordmark is collapsed', () => {
    localStorage.setItem('sidebar-v2-width', '76');
    renderSidebar(null);

    expect(screen.queryByRole('img', { name: 'PILOTDECK' })).toBeNull();
    const expand = screen.getByRole('button', { name: /Expand project sidebar|展开项目侧栏/ });
    expect(expand.querySelector('img')).toBeNull();
    fireEvent.click(expand);
    expect(screen.getByRole('img', { name: 'PILOTDECK' })).toBeTruthy();
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

  it('selects a project when its row is clicked', () => {
    const onSelectProject = vi.fn();
    renderSidebar(null, { onSelectProject });

    fireEvent.click(screen.getByRole('button', { name: /^PilotDeck$/ }));

    expect(onSelectProject).toHaveBeenCalledWith(project);
  });

  it('toggles project and conversation lists only from the chevron buttons', () => {
    const onStartNewSession = vi.fn();
    renderSidebar(general, { onStartNewSession });

    const projectsHeading = screen.getByRole('button', { name: 'Collapse projects' }).closest('.tree-heading') as HTMLElement;
    const conversationsHeading = screen.getByRole('button', { name: 'Collapse conversations' }).closest('.tree-heading') as HTMLElement;

    expect(screen.getByText('PilotDeck')).toBeTruthy();
    expect(within(projectsHeading).getByRole('button', { name: /Create new project|创建新项目/ })).toBeTruthy();
    expect(within(conversationsHeading).getByRole('button', { name: /Start a general conversation|新建通用对话/ })).toBeTruthy();

    fireEvent.click(screen.getByText('Projects'));
    expect(screen.getByText('PilotDeck')).toBeTruthy();
    fireEvent.click(within(projectsHeading).getByRole('button', { name: 'Collapse projects' }));
    expect(screen.queryByText('PilotDeck')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand projects' }));
    expect(screen.getByText('PilotDeck')).toBeTruthy();

    fireEvent.click(screen.getByText('Conversations'));
    expect(within(conversationsHeading).getByRole('button', { name: 'Collapse conversations' })).toBeTruthy();
    fireEvent.click(within(conversationsHeading).getByRole('button', { name: 'Collapse conversations' }));
    expect(screen.getByRole('button', { name: 'Expand conversations' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand conversations' }));
    expect(within(conversationsHeading).getByRole('button', { name: 'Collapse conversations' })).toBeTruthy();
  });

  it('starts conversations expanded and keeps the collapse control usable', () => {
    const chattyGeneral: Project = {
      ...general,
      sessions: [{ id: 's1', title: 'hello world', lastActivity: '2026-08-01' }],
    };
    renderSidebar(chattyGeneral, { projects: [chattyGeneral, project] });

    expect(screen.getByRole('button', { name: 'Collapse conversations' })).toBeTruthy();
    expect(screen.getByText('hello world')).toBeTruthy();
    expect(screen.getByText('PilotDeck')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversations' }));
    expect(screen.queryByText('hello world')).toBeNull();
  });

  it('starts a home new conversation from the top-left button', () => {
    const onStartHomeNewConversation = vi.fn();
    renderSidebar(general, { onStartHomeNewConversation });

    fireEvent.click(screen.getByText(/New conversation|新对话/));
    expect(onStartHomeNewConversation).toHaveBeenCalledTimes(1);
  });

  it('opens project creation from the Projects heading', () => {
    const onCreateProject = vi.fn();
    renderSidebar(general, { onCreateProject });

    fireEvent.click(screen.getByRole('button', { name: /Create new project|创建新项目/ }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
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

it('renders running, unread and idle indicators in the same slot', () => {
  const withSessions = {...project, sessions:[{id:'running',title:'Running'}, {id:'unread',title:'Unread'}, {id:'idle',title:'Idle'}]};
  const view = renderSidebar(withSessions, {projects:[withSessions],selectedSession:{id:'running'},processingSessions:new Set(['running']),unreadSessionIds:new Set(['running','unread'])});
  expect(view.container.querySelector('[data-session-indicator="running"]')?.getAttribute('data-status')).toBe('processing');
  expect(screen.getByTestId('running-indicator')).toBeTruthy();
  expect(view.container.querySelector('[data-session-indicator="unread"]')?.getAttribute('data-status')).toBe('unread');
  expect(view.container.querySelector('[data-session-indicator="idle"]')?.getAttribute('data-status')).toBe('idle');
});

it('shows waiting questions and approvals ahead of running and unread indicators', () => {
  const withSessions = {...project, sessions:[{id:'question',title:'Question'}, {id:'approval',title:'Approval'}]};
  const view = renderSidebar(withSessions, {projects:[withSessions],processingSessions:new Set(['question','approval']),unreadSessionIds:new Set(['question','approval']),waitingSessions:new Map([['question','question'],['approval','approval']])});
  expect(view.container.querySelector('[data-session-indicator="question"]')?.getAttribute('aria-label')).toMatch(/Waiting for your answer|等待你回答/);
  expect(view.container.querySelector('[data-session-indicator="approval"]')?.getAttribute('aria-label')).toMatch(/Waiting for approval|等待你审批/);
  expect(screen.queryByTestId('running-indicator')).toBeNull();
});

describe('desktop working-directory actions', () => {
  async function localizedOptions(language = 'en'): Promise<RenderOptions> {
    const i18n = await createTestI18n(language);
    i18n.addResourceBundle('en', 'sidebar', enSidebar);
    i18n.addResourceBundle('zh-CN', 'sidebar', zhSidebar);
    return { wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider> };
  }
  it.each([
    ['win32', 'en', 'Open in File Explorer'], ['win32', 'zh-CN', '在文件资源管理器中打开'],
    ['darwin', 'en', 'Open in Finder'], ['darwin', 'zh-CN', '在 Finder 中打开'],
    ['linux', 'en', 'Open in File Manager'], ['linux', 'zh-CN', '在文件管理器中打开'],
  ])('opens the session working directory on %s in %s', async (platform, language, label) => {
    const openDirectory = vi.fn().mockResolvedValue(true);
    window.pilotdeckDesktop = { platform, openDirectory } as never;
    const withSessions = { ...project, sessions: [{ id: 'native', title: 'Native chat', cwd: '/worktree/space 中文' }] };
    const onSelectSession = vi.fn();
    renderSidebar(withSessions, { projects: [withSessions], onSelectSession }, await localizedOptions(language));
    fireEvent.contextMenu(screen.getByText('Native chat'), { clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith('/worktree/space 中文'));
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the project directory when a conversation has no recorded cwd', async () => {
    const openDirectory = vi.fn().mockResolvedValue(true);
    window.pilotdeckDesktop = { platform: 'win32', openDirectory } as never;
    const withSessions = { ...project, sessions: [{ id: 'fallback', title: 'Fallback chat' }] };
    renderSidebar(withSessions, { projects: [withSessions] }, await localizedOptions());
    fireEvent.contextMenu(screen.getByText('Fallback chat'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Open in File Explorer|在文件资源管理器中打开/ }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith(project.fullPath));
    fireEvent.contextMenu(screen.getByText('PilotDeck'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Open in File Explorer|在文件资源管理器中打开/ }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledTimes(2));
  });

  it.each([general.fullPath, '/previous/general'])('uses the current General workspace instead of stale cwd %s', async (cwd) => {
    const openDirectory = vi.fn().mockResolvedValue(true);
    window.pilotdeckDesktop = { platform: 'darwin', openDirectory } as never;
    const withSessions = { ...general, workspaceCwd: '/managed/workspace', sessions: [{ id: 'general-chat', title: 'General chat', cwd }] };
    renderSidebar(withSessions, { projects: [withSessions] }, await localizedOptions());
    fireEvent.contextMenu(screen.getByText('General chat'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Open in Finder|在 Finder 中打开/ }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith('/managed/workspace'));
  });

  it('keeps native file manager actions out of the browser', () => {
    renderSidebar(project);
    fireEvent.contextMenu(screen.getByText('PilotDeck'));
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('inherits the parent working directory for a background conversation', async () => {
    const openDirectory = vi.fn().mockResolvedValue(true);
    window.pilotdeckDesktop = { platform: 'linux', openDirectory } as never;
    const withSessions: Project = { ...project, sessions: [
      { id: 'parent', title: 'Parent chat', cwd: '/worktree/parent' },
      { id: 'background', title: 'Background chat', parentSessionId: 'parent', sessionKind: 'background_task' },
    ] };
    renderSidebar(withSessions, { projects: [withSessions] }, await localizedOptions());
    fireEvent.contextMenu(screen.getByText('Background chat'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in File Manager' }));
    await waitFor(() => expect(openDirectory).toHaveBeenCalledWith('/worktree/parent'));
  });

  it('hides the action when General has no working directory', async () => {
    window.pilotdeckDesktop = { platform: 'darwin', openDirectory: vi.fn() } as never;
    const withSessions = { ...general, sessions: [{ id: 'legacy', title: 'Legacy general chat', cwd: general.fullPath }] };
    renderSidebar(withSessions, { projects: [withSessions] }, await localizedOptions());
    fireEvent.contextMenu(screen.getByText('Legacy general chat'));
    expect(screen.queryByRole('menuitem', { name: 'Open in Finder' })).toBeNull();
  });

  it.each([false, 'reject'])('reports a localized failure when opening returns %s', async failure => {
    const openDirectory = failure === false ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(new Error('missing'));
    window.pilotdeckDesktop = { platform: 'win32', openDirectory } as never;
    const toast = vi.fn();
    window.addEventListener('pilotdeck:toast', toast);
    try {
      renderSidebar(project, undefined, await localizedOptions(failure === false ? 'en' : 'zh-CN'));
      fireEvent.contextMenu(screen.getByText('PilotDeck'));
      fireEvent.click(screen.getByRole('menuitem', { name: /Open in File Explorer|在文件资源管理器中打开/ }));
      await waitFor(() => expect(toast).toHaveBeenCalledOnce());
      expect(toast.mock.calls[0][0].detail).toMatchObject({ kind: 'error' });
      expect(toast.mock.calls[0][0].detail.message).toMatch(/Could not open the working directory|无法打开工作目录/);
    } finally { window.removeEventListener('pilotdeck:toast', toast); }
  });
});
