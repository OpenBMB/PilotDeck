// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppTab, Project } from '../../../types/app';
import MainContent from './MainContent';

const mocks = vi.hoisted(() => ({
  handleFileOpen: vi.fn(),
  onMisroutedFileUrlHandled: vi.fn(),
}));

vi.mock('../../../contexts/TaskMasterContext', () => ({
  useTaskMaster: () => ({
    currentProject: { name: 'pilotdeck' },
    setCurrentProject: vi.fn(),
  }),
}));

vi.mock('../../../contexts/TasksSettingsContext', () => ({
  useTasksSettings: () => ({
    tasksEnabled: false,
    isTaskMasterInstalled: false,
    isTaskMasterReady: false,
  }),
}));

vi.mock('../../../hooks/useUiPreferences', () => ({
  useUiPreferences: () => ({
    preferences: {
      autoExpandTools: false,
      showRawParameters: false,
      showThinking: false,
      inlineThinking: false,
      autoScrollToBottom: true,
      sendByCtrlEnter: false,
    },
  }),
}));

vi.mock('../../code-editor/hooks/useEditorSidebar', () => ({
  useEditorSidebar: () => ({
    editorTabs: [{
      id: 'editor-tab-0',
      fileStack: [{
        name: 'report.pdf',
        path: '/workspace/PilotDeck/report.pdf',
        projectName: 'pilotdeck',
        diffInfo: null,
      }],
      dirty: false,
    }],
    activeEditorTabId: 'editor-tab-0',
    activeFilePath: '/workspace/PilotDeck/report.pdf',
    editingFile: {
      name: 'report.pdf',
      path: '/workspace/PilotDeck/report.pdf',
      projectName: 'pilotdeck',
      diffInfo: null,
    },
    editorWidth: 600,
    editorExpanded: false,
    hasManualWidth: false,
    resizeHandleRef: { current: null },
    handleFileOpen: mocks.handleFileOpen,
    handlePreviewFileOpen: vi.fn(),
    handleFileGoBack: vi.fn(),
    handleTabSelect: vi.fn(),
    handleTabClose: vi.fn(),
    handleTabDirtyChange: vi.fn(),
    handleFileRename: vi.fn(),
    handleFileDelete: vi.fn(),
    handleToggleEditorExpand: vi.fn(),
    handleResizeStart: vi.fn(),
  }),
}));

vi.mock('../../code-editor/view/EditorSidebar', () => ({
  default: () => <div data-testid="editor-sidebar" />,
}));

vi.mock('../../chat-v2/ChatInterfaceV2', () => ({
  default: ({ onFileOpen }: { onFileOpen: (filePath: string) => void }) => (
    <button type="button" onClick={() => onFileOpen('/workspace/PilotDeck/generated.pptx')}>
      Open workspace file
    </button>
  ),
}));

vi.mock('../../main-content-v2/FilesV2', () => ({
  default: () => <div data-testid="files-explorer" />,
}));

vi.mock('../../plugins/view/PluginTabContent', () => ({
  default: () => null,
}));

vi.mock('./ErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

class ResizeObserverMock {
  observe() {}

  disconnect() {}
}

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
};

function propsFor(activeTab: AppTab, setActiveTab = vi.fn()) {
  return {
    projects: [project],
    selectedProject: project,
    selectedSession: null,
    activeTab,
    setActiveTab,
    ws: null,
    sendMessage: vi.fn(),
    latestMessage: null,
    isMobile: false,
    onMenuClick: vi.fn(),
    isLoading: false,
    onInputFocusChange: vi.fn(),
    onSessionActive: vi.fn(),
    onSessionInactive: vi.fn(),
    onSessionProcessing: vi.fn(),
    onSessionNotProcessing: vi.fn(),
    processingSessions: new Set<string>(),
    unreadSessionIds: new Set<string>(),
    onReplaceTemporarySession: vi.fn(),
    onNavigateToSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onShowSettings: vi.fn(),
    externalMessageUpdate: 0,
  } as unknown as ComponentProps<typeof MainContent>;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  localStorage.clear();
  mocks.handleFileOpen.mockReset();
  mocks.onMisroutedFileUrlHandled.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('MainContent file workspace routing', () => {
  it('renders the editor only in Files and routes chat file opens into Files', async () => {
    const setActiveTab = vi.fn();
    const { rerender } = render(<MainContent {...propsFor('files', setActiveTab)} />);

    expect(await screen.findByTestId('editor-sidebar')).not.toBeNull();

    rerender(<MainContent {...propsFor('chat', setActiveTab)} />);
    expect(screen.queryByTestId('editor-sidebar')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open workspace file' }));
    expect(mocks.handleFileOpen).toHaveBeenCalledWith(
      '/workspace/PilotDeck/generated.pptx',
      null,
    );
    expect(setActiveTab).toHaveBeenCalledWith('files');
  });

  it('routes a file-shaped session URL into Files instead of chat', async () => {
    const setActiveTab = vi.fn();
    render(
      <MainContent
        {...propsFor('chat', setActiveTab)}
        misroutedFileFromUrl="/workspace/PilotDeck/report.pdf"
        onMisroutedFileUrlHandled={mocks.onMisroutedFileUrlHandled}
      />,
    );

    await waitFor(() => {
      expect(mocks.handleFileOpen).toHaveBeenCalledWith(
        '/workspace/PilotDeck/report.pdf',
        null,
      );
    });
    expect(setActiveTab).toHaveBeenCalledWith('files');
    expect(setActiveTab).not.toHaveBeenCalledWith('chat');
    expect(mocks.onMisroutedFileUrlHandled).toHaveBeenCalledOnce();
  });

  it('keeps the agent panel collapsible and persists keyboard resizing', async () => {
    render(<MainContent {...propsFor('files')} />);

    const conversationTrigger = await screen.findByTestId('files-conversation-switcher-trigger');
    const labels = conversationTrigger.querySelectorAll('span.block');
    expect(labels[0]?.textContent).toBe('filesWorkbench.assistant');
    expect(labels[1]?.textContent).toBe('filesWorkbench.conversations.newConversation');

    const resizeHandle = screen.getByRole('separator', {
      name: 'filesWorkbench.resizeAssistant',
    });
    expect(resizeHandle.getAttribute('aria-valuenow')).toBe('380');

    fireEvent.keyDown(resizeHandle, { key: 'ArrowLeft' });
    expect(resizeHandle.getAttribute('aria-valuenow')).toBe('396');
    await waitFor(() => {
      expect(localStorage.getItem('pilotdeck:files-assistant-width')).toBe('396');
    });

    fireEvent.click(screen.getByRole('button', { name: 'filesWorkbench.collapseAssistant' }));
    expect(screen.queryByRole('separator', { name: 'filesWorkbench.resizeAssistant' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'filesWorkbench.openAssistant' }));
    expect(screen.getByRole('separator', {
      name: 'filesWorkbench.resizeAssistant',
    }).getAttribute('aria-valuenow')).toBe('396');
  });
});
