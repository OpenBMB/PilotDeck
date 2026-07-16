// @vitest-environment jsdom
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import MainAreaV2 from './MainAreaV2';

vi.mock('../main-content/view/MainContent', async () => {
  const React = await import('react');
  const { useRegisterChatHistorySearchControls } = await import(
    '../chat-v2/ChatHistorySearchController'
  );

  function RegisteredSearchMock({ activeTab }: { activeTab: AppTab }) {
    const [isOpen, setIsOpen] = React.useState(false);
    const openSearch = React.useCallback(() => setIsOpen(true), []);
    const closeSearch = React.useCallback(() => setIsOpen(false), []);
    useRegisterChatHistorySearchControls({
      isOpen,
      openSearch,
      closeSearch,
    });

    return (
      <div
        data-testid="main-content"
        data-active-tab={activeTab}
        data-search-open={isOpen ? 'true' : 'false'}
      >
        {isOpen ? (
          <button type="button" onClick={() => setIsOpen(false)}>
            Mock close search
          </button>
        ) : null}
      </div>
    );
  }

  return {
    default: ({
      activeTab,
      selectedSession,
    }: {
      activeTab: AppTab;
      selectedSession: ProjectSession | null;
    }) => selectedSession
      ? <RegisteredSearchMock activeTab={activeTab} />
      : <div data-testid="main-content" data-active-tab={activeTab} />,
  };
});

vi.mock('../../utils/api', () => ({
  api: {
    alwaysOnDashboardEvents: vi.fn(async () => new Response(JSON.stringify({ events: [] }))),
  },
}));

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
};

function Harness({
  initialTab = 'chat',
  withSession = false,
}: {
  initialTab?: AppTab;
  withSession?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<AppTab>(initialTab);
  const props = {
    projects: [project],
    selectedProject: project,
    selectedSession: withSession ? { id: 'session-1', title: 'Searchable chat' } : null,
    activeTab,
    setActiveTab,
  } as unknown as ComponentProps<typeof MainAreaV2>;

  return <MainAreaV2 {...props} />;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('MainAreaV2 dashboard switcher', () => {
  it('places an available chat search button before Files and keeps its state in sync', async () => {
    render(<Harness initialTab="files" withSession />);

    const tools = screen.getByLabelText('Tools');
    const searchButton = within(tools).getByRole('button', { name: 'Search current conversation' });
    const filesButton = within(tools).getByRole('button', { name: 'tabs.files' });
    const toolButtons = within(tools).getAllByRole('button');

    expect(toolButtons[0]).toBe(searchButton);
    expect(toolButtons[1]).toBe(filesButton);
    expect(searchButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(searchButton);
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('chat');
    expect(screen.getByTestId('main-content').getAttribute('data-search-open')).toBe('true');
    expect(searchButton.getAttribute('aria-pressed')).toBe('true');
    expect(searchButton.className).toContain('bg-blue-100');
    expect(searchButton.className).toContain('text-blue-700');
    expect(searchButton.className).not.toContain('shadow');

    fireEvent.click(screen.getByRole('button', { name: 'Mock close search' }));
    await waitFor(() => expect(searchButton.getAttribute('aria-pressed')).toBe('false'));

    fireEvent.click(searchButton);
    fireEvent.click(filesButton);
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');
    expect(screen.getByTestId('main-content').getAttribute('data-search-open')).toBe('false');
    expect(searchButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('disables chat search while no conversation is mounted', () => {
    render(<Harness />);

    expect(
      (screen.getByRole('button', { name: 'Search current conversation' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('keeps chat implicit and toggles the Files workbench from its button', () => {
    render(<Harness />);

    expect(screen.queryByText('tabs.chat')).toBeNull();
    const filesButton = screen.getByRole('button', { name: 'tabs.files' });
    expect(filesButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(filesButton);
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('files');
    expect(filesButton.getAttribute('aria-pressed')).toBe('true');
    expect(filesButton.className).toContain('bg-blue-100');
    expect(filesButton.className).toContain('text-blue-700');
    expect(filesButton.className).not.toContain('shadow');

    fireEvent.click(filesButton);
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('chat');
    expect(filesButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('replaces the overflow button with the selected dashboard and restores it when closed', async () => {
    render(<Harness />);

    const overflowButton = screen.getByRole('button', { name: 'Open dashboards menu' });
    fireEvent.click(overflowButton);
    const menu = screen.getByRole('menu', { name: 'Dashboards' });
    expect(menu.className).toContain('z-[90]');
    expect(menu.className).toContain('w-32');
    expect(screen.getByRole('menuitem', { name: 'tabs.memory' }).className).toContain('justify-center');

    fireEvent.click(screen.getByRole('menuitem', { name: 'tabs.memory' }));
    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('memory');
    expect(screen.queryByRole('button', { name: 'Open dashboards menu' })).toBeNull();

    const memoryButton = screen.getByRole('button', { name: 'tabs.memory' });
    expect(memoryButton.getAttribute('aria-pressed')).toBe('true');
    expect(memoryButton.className).toContain('bg-blue-100');
    expect(memoryButton.className).toContain('text-blue-700');
    expect(memoryButton.className).not.toContain('shadow');
    fireEvent.click(memoryButton);

    expect(screen.getByTestId('main-content').getAttribute('data-active-tab')).toBe('chat');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open dashboards menu' })).not.toBeNull();
    });
  });
});
