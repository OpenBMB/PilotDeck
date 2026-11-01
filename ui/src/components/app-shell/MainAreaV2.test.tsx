// @vitest-environment jsdom
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import MainAreaV2 from './MainAreaV2';
import type { ReviewOpenRequest } from '../chat-review/ChatReviewContext';
import GlobalSearchDialog from '../global-search/GlobalSearchDialog';
import { GlobalSearchProvider, type GlobalSearchResult } from '../global-search/GlobalSearchContext';
import { api } from '../../utils/api';

vi.mock('../main-content/view/MainContent', async () => {
  const React = await import('react');
  const { useRegisterChatHistorySearchControls } = await import(
    '../chat-v2/ChatHistorySearchController'
  );

  function RegisteredSearchMock({ activeTab, reviewOpenRequest }: { activeTab: AppTab; reviewOpenRequest?: ReviewOpenRequest }) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [activeMatchIndex, setActiveMatchIndex] = React.useState(0);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const openSearch = React.useCallback(() => setIsOpen(true), []);
    const closeSearch = React.useCallback(() => {
      setIsOpen(false);
      setQuery('');
    }, []);
    const matches = query ? [{}, {}] : [];
    useRegisterChatHistorySearchControls({
      isOpen,
      openSearch,
      closeSearch,
      query,
      setQuery,
      matches,
      activeMatchIndex,
      goToPrevious: () => setActiveMatchIndex((index) => Math.max(0, index - 1)),
      goToNext: () => setActiveMatchIndex((index) => Math.min(matches.length - 1, index + 1)),
      inputRef,
    });

    return (
      <div
        data-testid="main-content"
        data-active-tab={activeTab}
        data-review-tab={reviewOpenRequest?.tab}
        data-review-request={reviewOpenRequest?.sequence}
        data-search-open={isOpen ? 'true' : 'false'}
        data-search-query={query}
        data-search-index={activeMatchIndex}
      >
        <button type="button" onClick={openSearch}>Open registered chat search</button>
      </div>
    );
  }

  return {
    default: ({
      activeTab,
      selectedSession,
      reviewOpenRequest,
    }: {
      activeTab: AppTab;
      selectedSession: ProjectSession | null;
      reviewOpenRequest?: ReviewOpenRequest;
    }) => selectedSession
      ? <RegisteredSearchMock activeTab={activeTab} reviewOpenRequest={reviewOpenRequest} />
      : <div data-testid="main-content" data-active-tab={activeTab} />,
  };
});

vi.mock('../../utils/api', () => ({
  api: {
    alwaysOnDashboardEvents: vi.fn(async () => new Response(JSON.stringify({ events: [] }))),
    globalSearch: vi.fn(async ({ query }: { query: string }) => new Response(JSON.stringify({
      groups: { chats: [1, 2].map(index => ({ id: 'hit-' + index, kind: 'chats', project,
        sessionId: 'session-' + index, title: 'Matched chat ' + index, snippet: query })), files: [] },
      counts: { chats: 2, files: 0 }, hasMore: { chats: false, files: false }, partial: [],
    }))),
  },
}));

vi.mock('../main-content-v2/CronV2', () => ({
  default: () => <div data-testid="cron-page" />,
}));

vi.mock('../main-content-v2/SkillsV2', () => ({
  default: () => <div data-testid="skills-page"><h1>Skills</h1></div>,
}));

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
};

function Harness({
  initialTab = 'chat',
  withSession = false,
  selectedProject = project,
  onSearchSelect = vi.fn(),
}: {
  initialTab?: AppTab;
  withSession?: boolean;
  selectedProject?: Project;
  onSearchSelect?: (result: GlobalSearchResult, query: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<AppTab>(initialTab);
  const props = {
    projects: [project],
    selectedProject,
    selectedSession: withSession ? { id: 'session-1', title: 'Searchable chat' } : null,
    activeTab,
    setActiveTab,
  } as unknown as ComponentProps<typeof MainAreaV2>;

  return <GlobalSearchProvider><MainAreaV2 {...props} />
    <GlobalSearchDialog projects={[project]} onSelect={onSearchSelect} />
  </GlobalSearchProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('MainAreaV2 dashboard switcher', () => {
  it('keeps General on chat and hides project-scoped Files and Explore tools', async () => {
    const generalProject: Project = {
      name: 'general',
      displayName: 'general',
      kind: 'general',
      fullPath: '/state/pilot-home',
      workspaceCwd: '/workspaces/general',
      capabilities: { files: false, explore: false, projectFileMentions: false },
    };

    render(<Harness initialTab="files" selectedProject={generalProject} />);

    expect(screen.queryByRole('button', { name: 'tabs.files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open dashboards menu' })).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('chat');
    });
  });

  it('renames the selected session inline after double-clicking the header title', () => {
    render(<Harness withSession />);

    const title = screen.getByTitle('Searchable chat');
    expect(title.hasAttribute('data-desktop-no-drag')).toBe(true);
    fireEvent.doubleClick(title);
    const input = screen.getByRole('textbox', { name: 'Rename Session' });
    expect((input as HTMLInputElement).value).toBe('Searchable chat');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'Renamed conversation' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTitle('Renamed conversation').textContent).toBe('Renamed conversation');
    expect(JSON.parse(localStorage.getItem('pilotdeck:customSessionTitles') || '{}')).toEqual({
      'session-1': 'Renamed conversation',
    });
  });

  it('cancels an inline session rename when Escape is pressed', () => {
    render(<Harness withSession />);

    fireEvent.doubleClick(screen.getByTitle('Searchable chat'));
    const input = screen.getByRole('textbox', { name: 'Rename Session' });
    fireEvent.change(input, { target: { value: 'Discarded title' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.getByTitle('Searchable chat').textContent).toBe('Searchable chat');
    expect(localStorage.getItem('pilotdeck:customSessionTitles')).toBeNull();
  });

  it('keeps header search absent and opens global search without leaving Files', () => {
    render(<Harness initialTab="files" withSession />);

    const tools = screen.getByLabelText('common:uiText.tools');
    const filesButton = within(tools).getByRole('button', { name: 'tabs.files' });
    const toolButtons = within(tools).getAllByRole('button');
    expect(toolButtons[0]).toBe(filesButton);
    expect(within(tools).queryByRole('button', { name: 'Search current conversation' })).toBeNull();
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');
    expect(within(screen.getByRole('banner')).queryByRole('search')).toBeNull();
    expect(screen.getByTitle('Searchable chat').textContent).toBe('Searchable chat');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');
  });

  it('makes global search available without a mounted conversation', () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: 'f', metaKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(api.globalSearch).not.toHaveBeenCalled();
  });

  it('does not leave Files when an embedded chat search opens', () => {
    render(<Harness initialTab="files" withSession />);

    fireEvent.click(screen.getByRole('button', { name: 'Open registered chat search' }));

    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');
    expect(screen.getByTestId('main-content').getAttribute('data-search-open')).toBe('true');
  });

  it('preserves Chinese composition and keyboard navigation in global search', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const onSearchSelect = vi.fn();
    render(<Harness withSession onSearchSelect={onSearchSelect} />);
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const input = screen.getByRole('combobox') as HTMLInputElement;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'wos' } });
    expect(input.value).toBe('wos');
    expect(api.globalSearch).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '我是' } });
    fireEvent.compositionEnd(input);

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, which: 13 });
    expect(onSearchSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(api.globalSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '我是' }), expect.anything()));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(input.value).toBe('我是');
    now.mockReturnValue(1_200);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, which: 13 });
    expect(onSearchSelect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2' }), '我是');
  });

  it('keeps chat implicit and toggles the Files workbench from its button', () => {
    render(<Harness />);

    expect(screen.queryByText('tabs.chat')).toBeNull();
    const filesButton = screen.getByRole('button', { name: 'tabs.files' });
    expect(filesButton.getAttribute('aria-pressed')).toBe('false');
    expect(filesButton.className).toContain('file-entry');

    fireEvent.click(filesButton);
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');
    expect(filesButton.getAttribute('aria-pressed')).toBe('true');
    expect(filesButton.className).toContain('file-entry');
    expect(filesButton.className).toContain('font-medium');

    fireEvent.click(filesButton);
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('chat');
    expect(filesButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the overflow menu available while a dashboard panel is open', async () => {
    render(<Harness />);

    const overflowButton = screen.getByRole('button', { name: 'Open dashboards menu' });
    expect(overflowButton.textContent).toContain('Explore');
    fireEvent.click(overflowButton);
    const menu = screen.getByRole('menu', { name: 'Dashboards' });
    expect(menu.className).toContain('z-[90]');
    expect(menu.className).toContain('w-44');
    expect(screen.getByRole('menuitem', { name: 'tabs.memory' }).className).toContain('justify-center');

    expect(screen.queryByRole('menuitem', { name: 'tabs.cron' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'tabs.skills' })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: 'tabs.memory' }));
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('memory');
    expect(screen.getByRole('button', { name: 'Open dashboards menu' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open dashboards menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'tabs.dashboard' }));
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('dashboard');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open dashboards menu' })).toBeTruthy();
    });
  });

  it('opens changes from the single Explore entry and emits a fresh request for each opening', () => {
    render(<Harness withSession />);
    expect(screen.queryByRole('button', { name: 'dashboardSwitcher.git' })).toBeNull();
    const menuButton = screen.getByRole('button', { name: 'Open dashboards menu' });
    fireEvent.click(menuButton);
    expect(screen.queryByRole('menuitem', { name: 'dashboardSwitcher.git' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'dashboardSwitcher.checkpoints' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'dashboardSwitcher.changes' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('main-content').getAttribute('data-review-tab')).toBe('changes');
    expect(screen.getByTestId('main-content').getAttribute('data-review-request')).toBe('1');
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByRole('menuitem', { name: 'dashboardSwitcher.changes' }));
    expect(screen.getByTestId('main-content').getAttribute('data-review-tab')).toBe('changes');
    expect(screen.getByTestId('main-content').getAttribute('data-review-request')).toBe('2');
  });

  it('replaces the workspace header with only the scheduled tasks title', async () => {
    render(<Harness initialTab="cron" withSession />);

    expect(await screen.findByRole('heading', { name: 'Scheduled Tasks' })).toBeTruthy();
    expect(screen.getByTestId('cron-page')).toBeTruthy();
    expect(screen.queryByTitle('Searchable chat')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search current conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'tabs.files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open dashboards menu' })).toBeNull();
  });

  it('lets the skills workbench own its header', async () => {
    render(<Harness initialTab="skills" withSession />);

    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeTruthy();
    expect(screen.getByTestId('skills-page')).toBeTruthy();
    expect(screen.queryByTitle('Searchable chat')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search current conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'tabs.files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open dashboards menu' })).toBeNull();
  });
});
