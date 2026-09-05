// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ChatInterfaceV2 from './ChatInterfaceV2';

const queueMocks = vi.hoisted(() => ({
  useSessionInputQueue: vi.fn(),
  useChatSessionState: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; project?: string }) => {
      if (key === 'welcome.greetingWithProject') {
        return `What do you want us to build in ${options?.project}?`;
      }
      return options?.defaultValue || key;
    },
  }),
}));

vi.mock('../../contexts/TasksSettingsContext', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: vi.fn(() => vi.fn()) }),
}));

vi.mock('../../stores/useSessionStore', () => ({
  useSessionStore: () => ({ refreshFromServer: vi.fn() }),
}));

vi.mock('../../hooks/useSessionWatch', () => ({ useSessionWatch: vi.fn() }));
vi.mock('../chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: vi.fn() }));

vi.mock('../chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    model: 'openai/gpt-test',
    modelCatalog: [],
    modelSelection: { mode: 'auto' },
    setModelSelection: vi.fn(async () => undefined),
    isModelCatalogLoading: false,
    modelCatalogError: null,
    thinkingModelContext: null,
    permissionMode: 'default',
    setPermissionMode: vi.fn(),
    pendingPermissionRequests: [],
    setPendingPermissionRequests: vi.fn(),
  }),
}));

vi.mock('../chat/hooks/useChatSessionState', () => ({
  useChatSessionState: queueMocks.useChatSessionState,
}));

vi.mock('../chat/hooks/useSessionInputQueue', () => ({
  useSessionInputQueue: queueMocks.useSessionInputQueue,
}));

vi.mock('../chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({
    input: '', setInput: vi.fn(), textareaRef: { current: null }, inputHighlightRef: { current: null },
    isTextareaExpanded: false, thinkingMode: 'default', slashCommandsCount: 0, filteredCommands: [],
    frequentCommands: [], commandQuery: '', showCommandMenu: false, selectedCommandIndex: 0,
    resetCommandMenuState: vi.fn(), dismissCommandMenu: vi.fn(), handleCommandSelect: vi.fn(),
    handleToggleCommandMenu: vi.fn(), showFileDropdown: false, fileMentionQuery: '', filteredFiles: [],
    selectedFileIndex: 0, isLoadingFiles: false, fileListError: null, hasMoreFiles: false,
    loadMoreFiles: vi.fn(), selectedFileMentions: [], removeFileMention: vi.fn(), selectedSkills: [],
    selectSkill: vi.fn(), removeSkill: vi.fn(), selectedCommands: [], removeSelectedCommand: vi.fn(),
    renderInputWithMentions: () => null, selectFile: vi.fn(), attachedImages: [], removeAttachedImage: vi.fn(),
    retryAttachmentUpload: vi.fn(), documentReferences: [], removeDocumentReference: vi.fn(),
    uploadingImages: new Map(), imageErrors: new Map(), getRootProps: () => ({}), getInputProps: () => ({}),
    isDragActive: false, openImagePicker: vi.fn(), addAttachmentFiles: vi.fn(), handleSubmit: vi.fn(),
    handleInputChange: vi.fn(), insertAtCursor: vi.fn(), handleKeyDown: vi.fn(), handlePaste: vi.fn(),
    handleTextareaClick: vi.fn(), handleTextareaInput: vi.fn(), syncInputOverlayScroll: vi.fn(),
    handleAbortSession: vi.fn(), handlePermissionDecision: vi.fn(), handleGrantToolPermission: vi.fn(),
    handleGrantSessionToolPermission: vi.fn(), handleInputFocusChange: vi.fn(),
  }),
}));

vi.mock('./MessagesPaneV2', () => ({ default: () => <div data-testid="messages-pane" /> }));
vi.mock('./ComposerV2', () => ({
  default: ({ queueTray }: { queueTray?: React.ReactNode }) => (
    <div data-testid="composer">{queueTray}</div>
  ),
}));

const createChatSessionState = (overrides: Record<string, unknown> = {}) => ({
  chatMessages: [], activityMessages: [], addMessage: vi.fn(), clearMessages: vi.fn(),
  rewindMessages: vi.fn(), isLoading: true, setIsLoading: vi.fn(), sessionRuntimeState: null,
  setSessionRuntimeState: vi.fn(), activeRunId: 'run-active', setActiveRunId: vi.fn(),
  currentSessionId: 'web:s_queue', setCurrentSessionId: vi.fn(), isLoadingSessionMessages: false,
  sessionLoadError: null, isLoadingMoreMessages: false, hasMoreMessages: false, totalMessages: 0,
  canAbortSession: true, setCanAbortSession: vi.fn(), isAborting: false, setIsAborting: vi.fn(),
  setIsUserScrolledUp: vi.fn(), tokenBudget: null, setTokenBudget: vi.fn(), visibleMessageCount: 0,
  visibleMessages: [], loadEarlierMessages: vi.fn(), loadAllMessages: vi.fn(), allMessagesLoaded: true,
  isLoadingAllMessages: false, claudeStatus: null, pilotDeckStatus: null, setClaudeStatus: vi.fn(),
  setPilotDeckStatus: vi.fn(), createDiff: vi.fn(), scrollContainerRef: { current: null },
  scrollToBottom: vi.fn(), handleScroll: vi.fn(),
  ...overrides,
});

const emptyQueue = () => ({
  queueState: { sessionId: null, revision: 0, paused: false, items: [] },
  enqueue: vi.fn(), remove: vi.fn(), moveToFront: vi.fn(), steer: vi.fn(), resume: vi.fn(),
});

describe('ChatInterfaceV2 queue integration', () => {
  it('connects the selected session queue and mounts the full queue tray', () => {
    queueMocks.useChatSessionState.mockReturnValue(createChatSessionState());
    queueMocks.useSessionInputQueue.mockReturnValue({
      queueState: {
        sessionId: 'web:s_queue',
        revision: 3,
        paused: false,
        items: [{
          id: 'queued-1',
          displayText: 'Keep the main queue',
          createdAt: new Date().toISOString(),
          status: 'queued',
        }],
      },
      enqueue: vi.fn(), remove: vi.fn(), moveToFront: vi.fn(), steer: vi.fn(), resume: vi.fn(),
    });

    render(<ChatInterfaceV2 {...({
      selectedProject: { name: 'PilotDeck', path: '/workspace/PilotDeck', fullPath: '/workspace/PilotDeck' },
      selectedSession: { id: 'web:s_queue' },
      ws: { readyState: WebSocket.OPEN },
      sendMessage: vi.fn(),
      processingSessions: new Set(['web:s_queue']),
    } as any)} />);

    expect(queueMocks.useSessionInputQueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'web:s_queue',
      projectPath: '/workspace/PilotDeck',
    }));
    expect(screen.getByRole('region', { name: 'Queued messages' })).toBeTruthy();
    expect(screen.getByText('Keep the main queue')).toBeTruthy();
  });

  it('uses the workspace binding in the welcome greeting', () => {
    queueMocks.useChatSessionState.mockReturnValue(createChatSessionState({
      isLoading: false,
      currentSessionId: null,
    }));
    queueMocks.useSessionInputQueue.mockReturnValue(emptyQueue());

    render(<ChatInterfaceV2 {...({
      selectedProject: null,
      selectedSession: null,
      workspaceBinding: {
        name: 'pilotdeck',
        displayName: 'PilotDeck',
        fullPath: '/workspace/PilotDeck',
      },
      projects: [],
      ws: null,
      sendMessage: vi.fn(),
    } as any)} />);

    expect(screen.getByRole('heading', {
      name: 'What do you want us to build in PilotDeck?',
    })).toBeTruthy();
  });

  it('keeps the generic greeting for a general conversation', () => {
    queueMocks.useChatSessionState.mockReturnValue(createChatSessionState({
      isLoading: false,
      currentSessionId: null,
    }));
    queueMocks.useSessionInputQueue.mockReturnValue(emptyQueue());

    render(<ChatInterfaceV2 {...({
      selectedProject: {
        name: 'general',
        displayName: 'general',
        fullPath: '/workspace/general',
      },
      selectedSession: null,
      projects: [],
      ws: null,
      sendMessage: vi.fn(),
    } as any)} />);

    expect(screen.getByRole('heading', { name: "What's on the plan today?" })).toBeTruthy();
  });
});
