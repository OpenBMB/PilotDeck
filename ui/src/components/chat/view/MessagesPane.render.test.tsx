// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FindShortcutProvider } from '../../../contexts/FindShortcutContext';
import type { ChatMessage, ChatRunMode, PendingPermissionRequest, SessionRuntimeState } from '../types/types';
import type { QueuedInputSummary } from '../types/queuedInput';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
import * as api from '../../../utils/api';
import { attachmentDisplayMetadata, rememberUploadedPreview } from '../utils/uploadedAttachmentPreview';
import { ChatReviewProvider } from '../../chat-review/ChatReviewContext';
import MessagesPane from './MessagesPane';
import { ChatHistorySearchControllerProvider } from './ChatHistorySearchController';
import { ThinkingBlock } from './ThinkingBlock';
import {
  getChatResponseReserveTarget,
  shouldKeepChatResponseReservedSpace,
} from '../utils/chatResponseReservedSpace';
import { getContextStatus } from './Composer';

vi.mock('./SubagentDetailModal', () => ({
  default: ({ isRunning }: { isRunning?: boolean }) => (
    <div data-testid="subagent-detail-modal" data-running={isRunning ? 'true' : 'false'} />
  ),
}));

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe('ThinkingBlock phase transitions', () => {
  it('opens while streaming, respects manual toggles, and closes once on completion', () => {
    const view = render(<ThinkingBlock content="First thought" isStreaming />);
    const toggle = screen.getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    view.rerender(<ThinkingBlock content="First thought and more" isStreaming />);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    view.rerender(<ThinkingBlock content="Completed thought" isStreaming={false} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    view.rerender(<ThinkingBlock content="Completed thought, persisted" isStreaming={false} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('getContextStatus', () => {
  it('keeps the visible count and percentage on the same display-token basis', () => {
    const status = getContextStatus({
      displayUsed: 11_928,
      budgetUsed: 12_080,
      total: 12_000,
      effectiveTotal: 12_000,
      state: 'blocking',
    });

    expect(status.used).toBe(11_928);
    expect(status.percentLabel).toBe('99%');
    // The padded request budget still controls the policy severity.
    expect(status.state).toBe('blocking');
    expect(status.tone).toBe('red');
  });

  it('prefers the resolved token count over a stale display estimate', () => {
    const status = getContextStatus({
      used: 12_080,
      displayUsed: 11_928,
      total: 12_000,
      effectiveTotal: 12_000,
      state: 'blocking',
    });

    expect(status.used).toBe(12_080);
    expect(status.percentLabel).toBe('100%+');
  });

  it('shows the full context window while calculating percent against the effective budget', () => {
    const status = getContextStatus({
      used: 38_161,
      total: 131_072,
      effectiveTotal: 98_304,
      reservedOutputTokens: 32_768,
      state: 'ok',
    });

    expect(status.displayTotal).toBe(131_072);
    expect(status.totalLabel).toBe('131k');
    expect(status.percentLabel).toBe('39%');
    expect(status.tone).toBe('normal');
  });
});

function processToggle(index = 0): HTMLButtonElement {
  let toggle = document.querySelectorAll<HTMLButtonElement>('[data-process-block] > button')[index];
  const hidden = toggle?.closest('[data-turn-process-region][aria-hidden="true"]');
  // Tool-specific assertions first open the enclosing completed-turn disclosure.
  if (!toggle || hidden) {
    const header = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-turn-process-header] button'))
      .find(button => button.getAttribute('aria-expanded') === 'false'
        && (!hidden || button.getAttribute('aria-controls')?.split(' ').includes(hidden.id)));
    if (header) fireEvent.click(header);
    toggle = document.querySelectorAll<HTMLButtonElement>('[data-process-block] > button')[index];
  }
  return toggle;
}

function makeMessage(index: number): ChatMessage {
  return {
    id: `m-${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index}`,
    timestamp: `2026-05-13T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
  };
}

function createPaneElement({
  messages,
  activityMessages = [],
  sendingInputs = [],
  isAssistantWorking = false,
  pendingPermissionRequests = [],
  sessionRuntimeState = 'synchronizing',
  activeRunId = null,
  runMode = 'agent',
  planModeActive = false,
  showThinking = true,
  inlineThinking = false,
  workingStatus,
  onRegenerate,
}: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  sendingInputs?: QueuedInputSummary[];
  isAssistantWorking?: boolean;
  pendingPermissionRequests?: PendingPermissionRequest[];
  sessionRuntimeState?: SessionRuntimeState;
  activeRunId?: string | null;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
  showThinking?: boolean;
  inlineThinking?: boolean;
  workingStatus?: import('../types/types').PilotDeckWorkStatus;
  onRegenerate?: (message: ChatMessage, editedText: string) => Promise<void>;
}) {
  const scrollContainerRef = React.createRef<HTMLDivElement>();

  return (
    <FindShortcutProvider activeScope="chat">
      <MessagesPane
        scrollContainerRef={scrollContainerRef}
        isLoadingSessionMessages={false}
        chatMessages={messages}
        activityMessages={activityMessages}
        sendingInputs={sendingInputs}
        visibleMessages={messages}
        visibleMessageCount={messages.length}
        isLoadingMoreMessages={false}
        hasMoreMessages={false}
        totalMessages={messages.length}
        loadEarlierMessages={() => {}}
        loadAllMessages={() => {}}
        allMessagesLoaded
        isLoadingAllMessages={false}
        provider="pilotdeck"
        selectedProject={null}
        selectedSession={null}
        createDiff={() => []}
        setInput={() => {}}
        isAssistantWorking={isAssistantWorking}
        pendingPermissionRequests={pendingPermissionRequests}
        sessionRuntimeState={sessionRuntimeState}
        activeRunId={activeRunId}
        runMode={runMode}
        planModeActive={planModeActive}
        showThinking={showThinking}
        inlineThinking={inlineThinking}
        workingStatus={workingStatus}
        onRegenerate={onRegenerate}
      />
    </FindShortcutProvider>
  );
}

function renderPane(options: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  sendingInputs?: QueuedInputSummary[];
  isAssistantWorking?: boolean;
  pendingPermissionRequests?: PendingPermissionRequest[];
  sessionRuntimeState?: SessionRuntimeState;
  activeRunId?: string | null;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
  showThinking?: boolean;
  inlineThinking?: boolean;
  workingStatus?: import('../types/types').PilotDeckWorkStatus;
  onRegenerate?: (message: ChatMessage, editedText: string) => Promise<void>;
}) {
  return render(createPaneElement(options));
}

it('shows retry progress over the previous completed tool activity', () => {
  renderPane({
    messages: [{ id: 'retry-user', type: 'user', content: 'Continue', timestamp: new Date().toISOString() }],
    activityMessages: [{ id: 'old-tool', type: 'assistant', content: '', timestamp: new Date().toISOString(), isToolUse: true,
      toolName: 'bash', toolInput: { command: 'pwd' }, toolResult: { content: '/workspace' } }],
    isAssistantWorking: true,
    workingStatus: { text: 'Reconnecting', tokens: 0, can_interrupt: true,
      retryProgress: { attempt: 1, maxAttempts: 5, delayMs: 500, reason: 'network_error', provider: 'test', model: 'model' } },
  });
  expect(screen.getByText('Reconnecting {{attempt}}/{{max}}{{delay}}')).toBeTruthy();
  expect(screen.getByText(/working.retryReasons.network_error/)).toBeTruthy();
});

it.each(['generate_image', 'edit_image'])('keeps the %s record in the completed trace while retaining exactly one image', async toolName => {
  const fetchImage = vi.spyOn(api, 'authenticatedFetch').mockResolvedValue({
    ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }),
  } as Response);
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => 'blob:delivered-image');
  URL.revokeObjectURL = vi.fn();
  try {
    const now = new Date().toISOString();
    const user: ChatMessage = { id: 'image-user', type: 'user', timestamp: now, content: 'Draw a house' };
    const pending: ChatMessage = { id: 'image-tool', toolId: 'image-tool', type: 'assistant', timestamp: now, content: '', isToolUse: true, toolName,
      toolInput: { prompt: 'A blue house', purpose: 'deliverable' } };
    const view = renderPane({ messages: [user, pending], isAssistantWorking: true });
    const surface = view.container.querySelector('.generated-image-surface');
    expect(surface?.getAttribute('aria-busy')).toBe('true');
    const complete: ChatMessage[] = [user, { ...pending, toolResult: { content: 'image_id: image-1', toolUseResult: { imageGeneration: {
      imageId: 'image-1', sessionId: 'session-1', width: 24, height: 16, mimeType: 'image/png', purpose: 'deliverable',
    } } } }, { id: 'image-answer', type: 'assistant', timestamp: now, content: 'Your picture is ready' }];
    view.rerender(createPaneElement({ messages: complete }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'imageGeneration.image' }).getAttribute('src')).toBe('blob:delivered-image'));
    fireEvent.load(screen.getByRole('img', { name: 'imageGeneration.image' }));
    expect(view.container.querySelector('.generated-image-surface')).toBe(surface);
    fireEvent.click(processToggle());
    const record = screen.getByRole('button', { name: `toolDisplay.done.tool ${toolName}` });
    fireEvent.click(record);
    expect(screen.getByText(/A blue house/)).toBeTruthy();
    expect(screen.getByText('image_id: image-1')).toBeTruthy();
    expect(view.container.querySelectorAll('.generated-image-card')).toHaveLength(1);
    view.rerender(createPaneElement({ messages: complete.map(message => ({ ...message })) }));
    expect(view.container.querySelectorAll('.generated-image-card')).toHaveLength(1);
    expect(screen.getByRole('button', { name: `toolDisplay.done.tool ${toolName}` })).toBeTruthy();
    expect(fetchImage).toHaveBeenCalledTimes(1);
  } finally {
    fetchImage.mockRestore();
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  }
});

function SessionPaneHarness({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: ChatMessage[];
}) {
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  return (
    <FindShortcutProvider activeScope="chat">
      <MessagesPane
        scrollContainerRef={scrollContainerRef}
        isLoadingSessionMessages={false}
        chatMessages={messages}
        visibleMessages={messages}
        visibleMessageCount={messages.length}
        isLoadingMoreMessages={false}
        hasMoreMessages={false}
        totalMessages={messages.length}
        loadEarlierMessages={() => {}}
        loadAllMessages={() => {}}
        allMessagesLoaded
        isLoadingAllMessages={false}
        provider="pilotdeck"
        selectedProject={{ name: 'project', displayName: 'Project', fullPath: '/project' }}
        selectedSession={{ id: sessionId }}
        createDiff={() => []}
        setInput={() => {}}
      />
    </FindShortcutProvider>
  );
}

describe('MessagesPane render behavior', () => {
  it('keeps conversation-local search controls visible inside the application shell provider', async () => {
    render(<ChatHistorySearchControllerProvider>{createPaneElement({ messages: [makeMessage(0), makeMessage(1)] })}</ChatHistorySearchControllerProvider>);
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    expect(screen.getByRole('search')).toBeTruthy();
    const input = screen.getByRole('search').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'Message' } });
    await waitFor(() => expect(document.querySelectorAll('mark.chat-history-search-highlight').length).toBeGreaterThan(0));
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
  });
  it('offers editing only on the latest user message', () => {
    const now = new Date().toISOString();
    renderPane({
      messages: [
        { id: 'user-old', turnId: 'turn-old', type: 'user', content: 'Old request', timestamp: now },
        { id: 'assistant-old', turnId: 'turn-old', type: 'assistant', content: 'Old answer', timestamp: now },
        { id: 'user-latest', turnId: 'turn-latest', type: 'user', content: 'Latest request', timestamp: now },
        { id: 'assistant-latest', turnId: 'turn-latest', type: 'assistant', content: 'Latest answer', timestamp: now },
      ],
      onRegenerate: vi.fn(async () => undefined),
    });

    expect(screen.getAllByRole('button', { name: 'Edit message' })).toHaveLength(1);
    const latestMessageRow = screen.getByText('Latest request').closest('.chat-message');
    expect(latestMessageRow?.querySelector('[aria-label="Edit message"]')).not.toBeNull();
    const oldMessageRow = screen.getByText('Old request').closest('.chat-message');
    expect(oldMessageRow?.querySelector('[aria-label="Edit message"]')).toBeNull();
  });

  it('shows a waiting state before the model produces content', () => {
    const now = new Date().toISOString();
    renderPane({
      messages: [{
        id: 'user-waiting',
        type: 'user',
        content: 'Please analyze this.',
        timestamp: now,
      }],
      isAssistantWorking: true,
      sessionRuntimeState: 'running',
    });

    expect(screen.getByText('Calling model...')).toBeTruthy();
    expect(screen.queryByText('Thinking...')).toBeNull();
  });

  it('switches to thinking when live reasoning arrives even if reasoning details are hidden', () => {
    const now = new Date().toISOString();
    renderPane({
      messages: [
        {
          id: 'user-thinking',
          type: 'user',
          content: 'Please analyze this.',
          timestamp: now,
        },
        {
          id: '__streaming_thinking_session_run',
          type: 'assistant',
          content: 'I am comparing the available approaches.',
          timestamp: now,
          isThinking: true,
          isStreaming: true,
        },
      ],
      isAssistantWorking: true,
      sessionRuntimeState: 'running',
      showThinking: false,
    });

    expect(screen.getByText('Thinking...')).toBeTruthy();
    expect(screen.queryByText('Waiting for model response...')).toBeNull();
    expect(screen.queryByText('I am comparing the available approaches.')).toBeNull();
  });

  it('lets the live thinking status row collapse and restore the scrollable reasoning window', () => {
    const now = new Date().toISOString();
    const thinkingContent = Array.from(
      { length: 12 },
      (_, index) => `Live thinking line ${index + 1}`,
    ).join('\n');
    renderPane({
      messages: [
        {
          id: 'user-live-thinking',
          type: 'user',
          content: 'Please think this through.',
          timestamp: now,
        },
        {
          id: '__streaming_thinking_session_live',
          type: 'assistant',
          content: thinkingContent,
          timestamp: now,
          isThinking: true,
          isStreaming: true,
        },
      ],
      isAssistantWorking: true,
      sessionRuntimeState: 'running',
    });

    const toggle = screen.getByRole('button', { name: /^Thinking for \d+s$/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const liveThinkingRegion = screen.getByRole('region', { name: 'Live thinking content' });
    expect(liveThinkingRegion).toBeTruthy();
    expect(liveThinkingRegion.closest('[role="status"]')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Live thinking content' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Live thinking content' })).toBeTruthy();
  });

  it('opens live reasoning when thinking details are enabled during a run', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'user-toggle-thinking',
        type: 'user',
        content: 'Please think this through.',
        timestamp: now,
      },
      {
        id: '__streaming_thinking_toggle_details',
        type: 'assistant',
        content: 'Reasoning that becomes visible later.',
        timestamp: now,
        isThinking: true,
        isStreaming: true,
      },
    ];
    const options = {
      messages,
      isAssistantWorking: true,
      sessionRuntimeState: 'running' as const,
    };
    const view = renderPane({ ...options, showThinking: false });

    expect(screen.queryByRole('region', { name: 'Live thinking content' })).toBeNull();

    view.rerender(createPaneElement({ ...options, showThinking: true }));

    expect(screen.getByRole('button', { name: /^Thinking for \d+s$/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Live thinking content' })).toBeTruthy();
  });

  it('preserves the same reasoning viewport when switching display modes during a run', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'user-toggle-inline-thinking',
        type: 'user',
        content: 'Please think this through.',
        timestamp: now,
      },
      {
        id: '__streaming_thinking_toggle_inline',
        type: 'assistant',
        content: 'Reasoning that moves out of the inline message.',
        timestamp: now,
        isThinking: true,
        isStreaming: true,
      },
    ];
    const options = {
      messages,
      isAssistantWorking: true,
      sessionRuntimeState: 'running' as const,
    };
    const view = renderPane({ ...options, inlineThinking: true });

    const region = screen.getByRole('region', { name: 'Live thinking content' });
    expect(screen.getAllByRole('button', { name: /^Thinking for \d+s$/ })).toHaveLength(1);

    view.rerender(createPaneElement({ ...options, inlineThinking: false }));

    expect(screen.getByRole('button', { name: /^Thinking for \d+s$/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Live thinking content' })).toBe(region);
  });

  it('stops an unfinished subagent from an older run while the next run is active', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'old-user',
        type: 'user',
        content: '上一轮',
        timestamp: now,
        runId: 'run-old',
        turnId: 'run-old',
      },
      {
        id: 'old-subagent',
        type: 'assistant',
        content: '',
        timestamp: now,
        runId: 'run-old',
        turnId: 'run-old',
        isToolUse: true,
        isSubagentContainer: true,
        toolName: 'Agent',
        toolId: 'old-subagent',
        subagentId: 'subagent-old',
        toolInput: JSON.stringify({ description: 'Historical subagent' }),
      },
      {
        id: 'new-user',
        type: 'user',
        content: '新一轮',
        timestamp: now,
        runId: 'run-new',
        turnId: 'run-new',
      },
      {
        id: 'new-assistant',
        type: 'assistant',
        content: 'Working on the new turn.',
        timestamp: now,
        runId: 'run-new',
        turnId: 'run-new',
      },
    ];

    renderPane({
      messages,
      activityMessages: [{
        id: 'old-subagent-activity',
        type: 'assistant',
        timestamp: now,
        isAgentActivity: true,
        activityId: 'subagent:subagent-old',
        parentRunId: 'run-old',
        phase: 'subagent',
        state: 'running',
      }],
      isAssistantWorking: true,
      sessionRuntimeState: 'running',
      activeRunId: 'run-new',
    });

    // Older turns fold when a newer user message arrives; inspect its details.
    fireEvent.click(document.querySelector('[data-turn-process-header] button')!);
    const card = screen.getByText('Historical subagent').closest('[role="button"]');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('subagent.status.stopped')).toBeTruthy();
    expect(within(card as HTMLElement).queryByText('subagent.status.thinking')).toBeNull();
    expect(screen.queryByText('Waiting for subagent')).toBeNull();
    fireEvent.click(card as HTMLElement);
    expect(screen.getByTestId('subagent-detail-modal').getAttribute('data-running')).toBe('false');
  });

  it('keeps an unfinished subagent in the active run running', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'new-user',
        type: 'user',
        content: '新一轮',
        timestamp: now,
        runId: 'run-new',
        turnId: 'run-new',
      },
      {
        id: 'new-subagent',
        type: 'assistant',
        content: '',
        timestamp: now,
        runId: 'run-new',
        turnId: 'run-new',
        isToolUse: true,
        isSubagentContainer: true,
        toolName: 'Agent',
        toolId: 'new-subagent',
        subagentId: 'subagent-new',
        toolInput: JSON.stringify({ description: 'Current subagent' }),
      },
    ];

    renderPane({
      messages,
      activityMessages: [{
        id: 'new-subagent-activity',
        type: 'assistant',
        timestamp: now,
        isAgentActivity: true,
        activityId: 'subagent:subagent-new',
        parentRunId: 'run-new',
        phase: 'subagent',
        state: 'running',
      }],
      isAssistantWorking: true,
      sessionRuntimeState: 'running',
      activeRunId: 'run-new',
    });

    const card = screen.getByText('Current subagent').closest('[role="button"]');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('subagent.status.thinking')).toBeTruthy();
    expect(within(card as HTMLElement).queryByText('subagent.status.stopped')).toBeNull();
    fireEvent.click(card as HTMLElement);
    expect(screen.getByTestId('subagent-detail-modal').getAttribute('data-running')).toBe('true');
  });

  it('uses a running activity from the active parent run for the live status', () => {
    const now = new Date().toISOString();
    renderPane({
      messages: [{
        id: 'new-user',
        type: 'user',
        content: '新一轮',
        timestamp: now,
        runId: 'run-new',
        turnId: 'run-new',
      }],
      activityMessages: [{
        id: 'new-subagent-activity',
        type: 'assistant',
        timestamp: now,
        isAgentActivity: true,
        activityId: 'subagent:subagent-new',
        parentRunId: 'run-new',
        phase: 'subagent',
        state: 'running',
      }],
      isAssistantWorking: true,
      sessionRuntimeState: 'running',
      activeRunId: 'run-new',
    });

    expect(screen.getByText('Waiting for subagent')).toBeTruthy();
  });

  it('uses message position for legacy subagents only after an active run is confirmed', () => {
    const now = new Date().toISOString();
    const legacyMessages: ChatMessage[] = [
      {
        id: 'old-user',
        type: 'user',
        content: '上一轮',
        timestamp: now,
      },
      {
        id: 'legacy-subagent',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        isSubagentContainer: true,
        toolName: 'Agent',
        toolId: 'legacy-subagent',
        subagentId: 'subagent-legacy',
        toolInput: JSON.stringify({ description: 'Legacy subagent' }),
      },
      {
        id: 'new-user',
        type: 'user',
        content: '新一轮',
        timestamp: now,
        runId: 'run-new',
        turnId: 'run-new',
      },
    ];

    const { rerender } = renderPane({
      messages: legacyMessages,
      isAssistantWorking: true,
      sessionRuntimeState: 'synchronizing',
      activeRunId: null,
    });
    fireEvent.click(document.querySelector('[data-turn-process-header] button')!);
    let card = screen.getByText('Legacy subagent').closest('[role="button"]');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('subagent.status.thinking')).toBeTruthy();

    rerender(createPaneElement({
      messages: legacyMessages,
      isAssistantWorking: true,
      sessionRuntimeState: 'running',
      activeRunId: 'run-new',
    }));
    card = screen.getByText('Legacy subagent').closest('[role="button"]');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('subagent.status.stopped')).toBeTruthy();
  });

  it('renders the default 100-message window without virtualization', () => {
    const messages = Array.from({ length: 100 }, (_, index) => makeMessage(index));

    renderPane({ messages });

    const container = screen.getByText('Message 0').closest('[data-total-message-count]');
    expect(container?.getAttribute('data-virtualized-messages')).toBeNull();
    expect(container?.getAttribute('data-rendered-message-count')).toBe('100');
  });

  it('renders only the viewport window for large conversations', () => {
    const messages = Array.from({ length: 220 }, (_, index) => makeMessage(index));

    renderPane({ messages });

    const container = screen.getByText('Message 0').closest('[data-total-message-count]');
    expect(container?.getAttribute('data-virtualized-messages')).toBe('true');
    expect(container?.getAttribute('data-total-message-count')).toBe('220');
    expect(Number(container?.getAttribute('data-rendered-message-count'))).toBeLessThan(220);
  });

  it('keeps a live process status visible when the process fragment has no renderable anchor', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = Array.from({ length: 4 }, (_, index) => ({
      id: `tool-${index}`,
      type: 'assistant',
      content: '',
      timestamp: now,
      isToolUse: true,
      toolName: 'Read',
      toolId: `tool-${index}`,
      toolInput: JSON.stringify({ file_path: `src/Orphaned-${index}.tsx` }),
    }));

    const { container } = renderPane({ messages, isAssistantWorking: true });

    expect(container.querySelector('[data-total-message-count]')?.getAttribute('data-total-message-count')).toBe('1');
    expect(processToggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Orphaned-3.tsx')).toBeTruthy();
  });

  it('resynchronizes a virtual window when the mounted pane changes sessions', async () => {
    const sessionAMessages = Array.from({ length: 220 }, (_, index) => ({
      ...makeMessage(index),
      content: `Session A message ${index}`,
    }));
    const sessionBMessages = Array.from({ length: 220 }, (_, index) => ({
      ...makeMessage(index),
      content: `Session B message ${index}`,
    }));
    const view = render(
      <SessionPaneHarness sessionId="session-a" messages={sessionAMessages} />,
    );
    const scrollSurface = view.container.querySelector<HTMLElement>('[data-chat-search-surface]');
    expect(scrollSurface).not.toBeNull();
    Object.defineProperty(scrollSurface, 'clientHeight', { configurable: true, value: 800 });

    scrollSurface!.scrollTop = 5000;
    fireEvent.scroll(scrollSurface!);
    await waitFor(() => {
      expect(screen.queryByText('Session A message 0')).toBeNull();
    });

    // Simulate the browser clamping the reused element without dispatching a
    // scroll event while React replaces the conversation contents.
    scrollSurface!.scrollTop = 0;
    view.rerender(
      <SessionPaneHarness sessionId="session-b" messages={sessionBMessages} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Session B message 0')).toBeTruthy();
    });
  });

  it('renders live processing time above the active assistant turn with activity status', () => {
    const messages = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续优化',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect the current UI.',
        timestamp: new Date().toISOString(),
      },
    ];
    const activityMessages: ChatMessage[] = [
      {
        id: 'activity-1',
        type: 'system',
        content: 'Searching files',
        timestamp: new Date().toISOString(),
        isAgentActivity: true,
        activityId: 'activity-1',
        phase: 'rag',
        state: 'running',
        title: 'Searching files',
        detail: 'MessagesPane.tsx',
        startedAt: new Date(Date.now() - 2000).toISOString(),
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    const statuses = screen.getAllByRole('status');
    const headerStatus = statuses[0];
    const liveStatus = statuses[1];
    const userText = screen.getByText('继续优化');
    const assistantText = screen.getByText('I will inspect the current UI.');
    expect(statuses).toHaveLength(2);
    expect(headerStatus.textContent).toContain('Processed');
    expect(headerStatus.querySelector('button')).toBeNull();
    expect(userText.closest('.chat-message')?.className).toContain('pb-2');
    expect(liveStatus.textContent).toContain('Searching files');
    expect(liveStatus.querySelector('button')).toBeNull();
    expect(Boolean(headerStatus.compareDocumentPosition(assistantText) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('keeps the processed duration visible after the active turn completes', () => {
    const now = '2026-05-18T08:00:00.000Z';
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续优化',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I finished the changes.',
        timestamp: '2026-05-18T08:01:20.000Z',
      },
      {
        id: 'summary-1',
        type: 'system',
        content: 'Process summary',
        timestamp: '2026-05-18T08:01:20.000Z',
        isAgentActivitySummary: true,
        durationMs: 80000,
        state: 'completed',
      },
    ];

    renderPane({ messages });

    const headerStatus = screen.getByText('Processed 1m 20s').closest('[role="status"]');
    const userText = screen.getByText('继续优化');
    const assistantText = screen.getByText('I finished the changes.');

    expect(headerStatus).not.toBeNull();
    expect(headerStatus?.querySelector('button')).toBeNull();
    expect(Boolean(userText.compareDocumentPosition(headerStatus as Element) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean((headerStatus as Element).compareDocumentPosition(assistantText) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('keeps live tool calls collapsed but lets the running status expand their details', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '检查文件',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect the current file.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/HiddenTool.tsx"}',
      },
    ];
    const activityMessages: ChatMessage[] = [
      {
        id: 'activity-1',
        type: 'system',
        content: 'Reading file',
        timestamp: now,
        isAgentActivity: true,
        activityId: 'activity-1',
        toolId: 'tool-read-1',
        phase: 'tool',
        state: 'running',
        title: 'Reading file',
        startedAt: now,
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    expect(screen.getByText('HiddenTool.tsx')).toBeTruthy();
    expect(screen.queryByText('Reading file')).toBeNull();
    const expandButton = screen.getByText('HiddenTool.tsx').closest('button');
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('src/HiddenTool.tsx')).toBeNull();

    fireEvent.click(expandButton as HTMLButtonElement);

    expect(expandButton?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('HiddenTool.tsx')).toBeTruthy();
  });

  it('renders expanded plan-mode bash denials as neutral collapsed tool details', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '列一下文件',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect the current directory.',
        timestamp: now,
      },
      {
        id: 'tool-bash-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'bash',
        toolId: 'tool-bash-1',
        toolInput: '{"command":"find . -maxdepth 1 -type f","description":"List files"}',
        toolResult: {
          content: 'Plan mode denies side-effecting tool bash.',
          isError: true,
          errorCode: 'permission_denied',
        },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'I will use a read-only approach instead.',
        timestamp: now,
      },
    ];

    const { container } = renderPane({ messages, isAssistantWorking: true, runMode: 'plan' });

    expect(processToggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(processToggle());
    const toolButton = container.querySelector('.tool-call button[aria-expanded]') as HTMLButtonElement;
    expect(toolButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toolButton);
    expect(screen.getByText(/find \. -maxdepth 1 -type f/)).toBeTruthy();
    expect(screen.queryByText('common:uiText.parameters')).toBeNull();
    expect(container.querySelector('.border-l-red-500')).toBeNull();
    expect(screen.queryByRole('button', { name: /permissions\.grant|Grant Bash for this chat/ })).toBeNull();

    expect(screen.getByText(/Plan mode denies side-effecting tool bash/)).toBeTruthy();
    expect(toolButton.textContent).not.toMatch(/error/i);
  });

  it('preserves an expanded live process row while streamed tool groups grow', () => {
    const now = new Date().toISOString();
    const baseMessages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '检查文件',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect the current file.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/ReadHidden.tsx"}',
      },
    ];
    const { rerender } = renderPane({ messages: baseMessages, isAssistantWorking: true });

    const expandButton = screen.getByText('ReadHidden.tsx').closest('button');
    expect(expandButton).not.toBeNull();
    fireEvent.click(expandButton as HTMLButtonElement);
    expect(expandButton?.getAttribute('aria-expanded')).toBe('true');

    const nextMessages: ChatMessage[] = [
      ...baseMessages,
      {
        id: 'tool-grep-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Grep',
        toolId: 'tool-grep-1',
        toolInput: '{"pattern":"Footer"}',
      },
    ];
    rerender(createPaneElement({ messages: nextMessages, isAssistantWorking: true }));

    const updatedStatus = screen.getByText('Footer').closest('[data-process-block]');
    expect(updatedStatus).not.toBeNull();
    const updatedButton = updatedStatus?.querySelector('button');
    expect(updatedButton?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('ReadHidden.tsx')).toBeTruthy();
  });

  it('preserves process row expansion when a live turn completes', () => {
    const now = new Date().toISOString();
    const baseMessages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '检查文件',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect first.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/ReadHidden.tsx"}',
      },
    ];
    const { rerender } = renderPane({ messages: baseMessages, isAssistantWorking: true });

    const expandButton = screen.getByText('ReadHidden.tsx').closest('button');
    expect(expandButton).not.toBeNull();
    fireEvent.click(expandButton as HTMLButtonElement);
    expect(expandButton?.getAttribute('aria-expanded')).toBe('true');

    const completedMessages: ChatMessage[] = [
      {
        ...baseMessages[0],
      },
      {
        ...baseMessages[1],
      },
      {
        ...baseMessages[2],
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Done.',
        timestamp: now,
      },
    ];
    rerender(createPaneElement({ messages: completedMessages }));
    const turnToggle = processToggle();
    expect(turnToggle.getAttribute('aria-expanded')).toBe('true');

    expect(screen.getByText('Explored 1 file')).toBeTruthy();
    const completedButton = screen.getByText('ReadHidden.tsx').closest('button');
    expect(completedButton?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('ReadHidden.tsx')).toBeTruthy();
  });

  it('preserves expanded tool parameters when live ids are replaced by persisted ids', async () => {
    const now = new Date().toISOString();
    const liveMessages: ChatMessage[] = [
      {
        id: 'live-user-frame',
        turnId: 'turn-1',
        runId: 'turn-1',
        type: 'user',
        content: '检查代码',
        timestamp: now,
      },
      {
        id: 'live-assistant-frame',
        turnId: 'turn-1',
        runId: 'turn-1',
        type: 'assistant',
        content: '我先运行检查。',
        timestamp: now,
      },
      {
        id: 'live-tool-frame',
        turnId: 'turn-1',
        runId: 'turn-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'execute_code',
        toolId: 'call-stable-1',
        toolInput: '{"code":"print(1)"}',
      },
    ];
    const { container, rerender } = renderPane({ messages: liveMessages, isAssistantWorking: true });

    const parametersSummary = container.querySelector('.tool-call button[aria-expanded]') as HTMLButtonElement;
    expect(parametersSummary.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(parametersSummary);
    await waitFor(() => expect(parametersSummary.getAttribute('aria-expanded')).toBe('true'));

    const persistedMessages: ChatMessage[] = [
      {
        ...liveMessages[0],
        id: 'persisted-user-entry',
      },
      {
        ...liveMessages[1],
        id: 'persisted-assistant-entry',
      },
      {
        ...liveMessages[2],
        id: 'persisted-tool-entry',
        toolResult: { content: '1', isError: false },
      },
      {
        id: 'persisted-final-answer',
        turnId: 'turn-1',
        runId: 'turn-1',
        type: 'assistant',
        content: '检查完成。',
        timestamp: now,
      },
    ];
    rerender(createPaneElement({ messages: persistedMessages }));
    const turnToggle = processToggle();
    expect(turnToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(turnToggle);

    expect(screen.getByText('Ran 1 command')).toBeTruthy();
    const persistedParameters = container.querySelector('.tool-call button[aria-expanded]');
    expect(persistedParameters?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/print\(1\)/)).toBeTruthy();
  });

  it('does not search hidden completed process detail content', async () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '检查文件',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/SearchHiddenNeedle.tsx"}',
        toolResult: { content: 'HiddenResultNeedle', isError: false },
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'Done.',
        timestamp: now,
      },
    ];

    renderPane({ messages });
    const turnToggle = processToggle();
    expect(turnToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(turnToggle);

    const processButton = screen.getByText('SearchHiddenNeedle.tsx').closest('button');
    expect(processButton?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('HiddenResultNeedle')).toBeNull();

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const search = screen.getByRole('search');
    const input = search.querySelector('input[type="search"]') as HTMLInputElement | null;
    if (!input) throw new Error('Expected chat search input');
    fireEvent.change(input, { target: { value: 'HiddenResultNeedle' } });

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Previous match' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: 'Next match' }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(processButton?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('mark.chat-history-search-highlight-active')).toBeNull();
  });

  it('does not capture the find shortcut from an active file search surface', () => {
    renderPane({ messages: [makeMessage(0)] });
    const fileSurface = document.createElement('div');
    fileSurface.dataset.fileSearchSurface = '';
    const fileInput = document.createElement('input');
    fileSurface.append(fileInput);
    document.body.append(fileSurface);

    fireEvent.keyDown(fileInput, { key: 'f', ctrlKey: true });

    expect(screen.queryByRole('search')).toBeNull();
    fileSurface.remove();
  });

  it('moves between mounted search results without resetting the conversation scroll position', async () => {
    const messages: ChatMessage[] = [
      {
        id: 'u-search-1',
        type: 'user',
        content: 'First visible needle',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'a-search-2',
        type: 'assistant',
        content: 'Second visible needle',
        timestamp: new Date().toISOString(),
      },
    ];

    renderPane({ messages });

    const messageList = screen.getByText('First visible needle').closest('[data-total-message-count]');
    const scrollContainer = messageList?.parentElement as HTMLElement | null;
    if (!scrollContainer) throw new Error('Expected conversation scroll container');

    let currentScrollTop = 240;
    const setScrollTop = vi.fn((value: number) => {
      currentScrollTop = value;
    });
    const scrollTo = vi.fn();
    Object.defineProperty(scrollContainer, 'scrollTop', {
      configurable: true,
      get: () => currentScrollTop,
      set: setScrollTop,
    });
    Object.defineProperty(scrollContainer, 'clientHeight', {
      configurable: true,
      value: 400,
    });
    scrollContainer.scrollTo = scrollTo;

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const searchInput = screen.getByRole('search').querySelector('input[type="search"]');
    if (!(searchInput instanceof HTMLInputElement)) throw new Error('Expected chat search input');
    fireEvent.change(searchInput, { target: { value: 'needle' } });

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalled();
      expect(document.querySelectorAll('mark.chat-history-search-highlight')).toHaveLength(2);
      expect(document.querySelectorAll('mark.chat-history-search-highlight-active')).toHaveLength(1);
    });
    expect(
      document.querySelector('mark.chat-history-search-highlight-active')?.closest('[data-message-key]')
        ?.getAttribute('data-message-key'),
    ).toContain('u-search-1');
    scrollTo.mockClear();
    setScrollTop.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({
      behavior: 'smooth',
    })));
    expect(document.querySelectorAll('mark.chat-history-search-highlight')).toHaveLength(2);
    expect(
      document.querySelector('mark.chat-history-search-highlight-active')?.closest('[data-message-key]')
        ?.getAttribute('data-message-key'),
    ).toContain('a-search-2');
    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it('keeps separated live process rows at the positions where they happened', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续检查',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect files first.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/FirstHidden.tsx"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Now I will verify the build.',
        timestamp: now,
      },
      {
        id: 'tool-bash-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Bash',
        toolId: 'tool-bash-1',
        toolInput: '{"command":"npm run build"}',
      },
    ];

    renderPane({ messages, isAssistantWorking: true });

    const firstAssistant = screen.getByText('I will inspect files first.');
    const firstStatus = processToggle();
    const secondAssistant = screen.getByText('Now I will verify the build.');
    const runningStatus = screen.getByText('npm run build');

    expect(Boolean(firstAssistant.compareDocumentPosition(firstStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(firstStatus.compareDocumentPosition(secondAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(secondAssistant.compareDocumentPosition(runningStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    const expandButton = firstStatus;
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expandButton as HTMLButtonElement);

    expect(screen.getByText('FirstHidden.tsx')).toBeTruthy();
    expect(firstAssistant.closest('.chat-message')?.className).not.toContain('pb-8');
  });

  it('keeps completed process rows in their original positions after the turn finishes', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续优化',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will inspect first.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/FirstHidden.tsx"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Now I will run checks.',
        timestamp: now,
      },
      {
        id: 'tool-bash-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Bash',
        toolId: 'tool-bash-1',
        toolInput: '{"command":"npm test"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-3',
        type: 'assistant',
        content: 'All done.',
        timestamp: now,
      },
    ];

    renderPane({ messages });
    const turnToggle = processToggle();
    expect(turnToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(turnToggle);

    const firstAssistant = screen.getByText('I will inspect first.');
    fireEvent.click(processToggle(1));
    const readSummary = screen.getByText('FirstHidden.tsx');
    const secondAssistant = screen.getByText('Now I will run checks.');
    const commandSummary = screen.getByText('npm test');
    const finalAssistant = screen.getByText('All done.');

    expect(Boolean(firstAssistant.compareDocumentPosition(readSummary) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(readSummary.compareDocumentPosition(secondAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(secondAssistant.compareDocumentPosition(commandSummary) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(commandSummary.compareDocumentPosition(finalAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('shows model-call status after a closed live tool group while the assistant continues', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '继续优化',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I inspected the file.',
        timestamp: now,
      },
      {
        id: 'tool-read-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Read',
        toolId: 'tool-read-1',
        toolInput: '{"file_path":"src/ClosedTool.tsx"}',
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Now I am writing the response.',
        timestamp: now,
      },
    ];
    const activityMessages: ChatMessage[] = [
      {
        id: 'activity-1',
        type: 'system',
        content: 'Reading file',
        timestamp: now,
        isAgentActivity: true,
        activityId: 'activity-1',
        phase: 'tool',
        state: 'completed',
        title: 'Reading file',
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    expect(processToggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(processToggle());
    expect(screen.getByText('ClosedTool.tsx')).toBeTruthy();
    expect(screen.getByText('Calling model...')).toBeTruthy();
    expect(screen.queryByText('Reading file')).toBeNull();
  });

  it('folds ordinary failed tools into a neutral process row without error counts', () => {
    const now = new Date().toISOString();
    const failedResult = {
      content: '<tool_use_error>InputValidationError: missing file_path</tool_use_error>',
      isError: true,
      errorCode: 'tool_execution_failed',
    };
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '修一下页面',
        timestamp: now,
      },
      {
        id: 'tool-edit-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'write_file',
        toolId: 'tool-edit-1',
        toolInput: '{"file_path":"src/FailedTool.tsx","content":"export const failed = true;"}',
        toolResult: failedResult,
      },
      {
        id: 'tool-grep-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'Grep',
        toolId: 'tool-grep-1',
        toolInput: '{"pattern":"Footer"}',
        toolResult: failedResult,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will retry with corrected inputs.',
        timestamp: now,
      },
    ];

    const { container } = renderPane({ messages });
    const turnToggle = processToggle();
    expect(turnToggle.getAttribute('aria-expanded')).toBe('false');

    expect(screen.queryByText('Tool error')).toBeNull();
    expect(screen.queryByText('FailedTool.tsx')).toBeNull();

    const summary = screen.getByText(/Edited 1 file.*Searched 1 time/);
    const button = summary.closest('button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.querySelector('.text-amber-600, .text-red-500')).toBeNull();

    fireEvent.click(button as HTMLButtonElement);

    expect(screen.getByText('FailedTool.tsx')).toBeTruthy();
    expect(summary.textContent).not.toMatch(/error/i);
    const failedTool = container.querySelector('.tool-call button[aria-expanded]') as HTMLButtonElement;
    fireEvent.click(failedTool);
    expect(container.querySelector('.tool-details')).not.toBeNull();
    expect(container.querySelector('.border-l-red-500')).toBeNull();
  });

  it('shows a single waiting status for an in-progress web_fetch in plan mode', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '搜索一下',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: '我去查一下文档。',
        timestamp: now,
      },
      {
        id: 'tool-fetch-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'web_fetch',
        toolId: 'tool-fetch-1',
        toolInput: '{"url":"https://example.com"}',
      },
    ];

    renderPane({ messages, isAssistantWorking: true, runMode: 'plan', planModeActive: true });

    expect(screen.getAllByText('https://example.com')).toHaveLength(1);
    expect(document.querySelectorAll('.tool-call')).toHaveLength(1);
    expect(document.querySelectorAll('.process-live-status')).toHaveLength(0);
  });

  it('shows a single web_fetch status in agent mode', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '搜索一下',
        timestamp: now,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: '我去查一下文档。',
        timestamp: now,
      },
      {
        id: 'tool-fetch-1',
        type: 'assistant',
        content: '',
        timestamp: now,
        isToolUse: true,
        toolName: 'web_fetch',
        toolId: 'tool-fetch-1',
        toolInput: '{"url":"https://example.com"}',
      },
    ];

    renderPane({ messages, isAssistantWorking: true, runMode: 'agent' });

    expect(screen.getAllByText('https://example.com')).toHaveLength(1);
    expect(document.querySelectorAll('.tool-call')).toHaveLength(1);
    expect(document.querySelectorAll('.process-live-status')).toHaveLength(0);
  });

  it('updates the same live compression row from running to completed without a second status', () => {
    const timestamp = new Date().toISOString();
    const user: ChatMessage = { id: 'user', type: 'user', content: 'Continue', timestamp };
    const compact: ChatMessage = { id: 'compact-start', type: 'system', content: '', timestamp,
      isCompactBoundary: true, compactionId: 'c1', compactState: 'running' };
    const view = renderPane({ messages: [user, compact], isAssistantWorking: true });
    const row = screen.getByText('Compacting context...');
    expect(screen.queryByText('Compacted context')).toBeNull();
    view.rerender(createPaneElement({ messages: [user, { ...compact, id: 'compact-history', compactState: 'completed' }], isAssistantWorking: true }));
    expect(screen.queryByText('Compacting context...')).toBeNull();
    expect(screen.getByText('Compacted context')).toBe(row);
  });

  it('keeps thinking before mid-turn compaction inside the completed trace', () => {
    const now = new Date().toISOString();
    renderPane({ messages: [
      { id: 'user', type: 'user', content: 'Inspect the image', timestamp: now },
      { id: 'thought', type: 'assistant', content: 'Reasoning before compaction', timestamp: now, isThinking: true },
      { id: 'compact', type: 'system', content: 'Context compacted', timestamp: now, isCompactBoundary: true },
      { id: 'answer', type: 'assistant', content: 'Answer after compaction', timestamp: now },
    ] });
    fireEvent.click(processToggle());
    const thought = screen.getByRole('button', { name: 'Finished thinking' });
    const compact = within(document.querySelector('[data-turn-trace]') as HTMLElement).getByText('Compacted context');
    const answer = screen.getByText('Answer after compaction');
    expect(thought.compareDocumentPosition(compact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(compact.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not render a completed compact boundary as a plan-mode process row', () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: 'u-1',
        type: 'user',
        content: '先规划一下',
        timestamp: now,
      },
      {
        id: 'compact-1',
        type: 'system',
        content: 'Context compacted',
        timestamp: now,
        isCompactBoundary: true,
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'I will make a plan first.',
        timestamp: now,
      },
    ];

    renderPane({ messages, isAssistantWorking: true, runMode: 'plan', planModeActive: true });

    expect(screen.getByText('I will make a plan first.')).toBeTruthy();
    expect(processToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('uses compact message spacing instead of the old large row gap', () => {
    const messages = [
      {
        id: 'u-1',
        type: 'user',
        content: '调整一下',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'First assistant line.',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'a-2',
        type: 'assistant',
        content: 'Second assistant line.',
        timestamp: new Date().toISOString(),
      },
    ];

    renderPane({ messages, isAssistantWorking: true });

    expect(screen.getByText('First assistant line.').closest('[data-turn-process-region]')?.querySelector('.pb-2')).toBeTruthy();
    expect(screen.getByText('First assistant line.').closest('.chat-message')?.className).not.toContain('pb-8');
  });
  it('keeps prose mounted while work closes and preserves reopening across history refresh', async () => {
    const user = makeMessage(0);
    const thought: ChatMessage = { ...makeMessage(1), id: 'thought', isThinking: true, isStreaming: true, content: 'Inspecting' };
    const interim = { ...makeMessage(3), content: 'Intermediate inspection.' };
    const view = renderPane({ messages: [user, thought], isAssistantWorking: true });
    const seat = view.container.querySelector('[data-process-block]');
    expect(processToggle().getAttribute('aria-expanded')).toBe('true');
    view.rerender(createPaneElement({ messages: [user, { ...thought, isStreaming: false }, interim], isAssistantWorking: true }));
    expect(view.container.querySelector('[data-process-block]')).toBe(seat);
    expect(processToggle().getAttribute('aria-expanded')).toBe('false');
    const prose = await screen.findByText('Intermediate inspection.');
    fireEvent.click(processToggle());
    view.rerender(createPaneElement({ messages: [user, { ...thought, isStreaming: false }, { ...interim },
      { ...makeMessage(5), content: 'Final answer.' }] }));
    expect(processToggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Intermediate inspection.')).toBe(prose);
    expect(await screen.findByText('Final answer.')).toBeTruthy();
    fireEvent.click(processToggle());
    expect(screen.getByText('Intermediate inspection.')).toBe(prose);
  });

  it('reveals a completed process when searching a tool title and leaves prose visible', async () => {
    renderPane({ messages: [makeMessage(0),
      { ...makeMessage(1), isToolUse: true, toolName: 'Read', toolInput: { file_path: 'unique needle.ts' }, content: '' },
      { ...makeMessage(3), content: 'Final answer.' },
    ] });
    const runToggle = document.querySelector('[data-turn-process-header] button')!;
    expect(runToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const input = screen.getByRole('search').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'unique needle' } });
    await waitFor(() => expect(runToggle.getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(document.querySelector('[data-process-block] > button')?.getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(document.querySelector('mark.chat-history-search-highlight-active')?.textContent).toBe('unique needle'));
    expect(screen.getByText('Final answer.')).toBeTruthy();
  });

  it.each(['error', 'interrupted', 'no-final'])('keeps %s turns visible', (kind) => {
    const messages: ChatMessage[] = [makeMessage(0), { ...makeMessage(1), content: 'Working details.' }];
    if (kind === 'error') messages.push({ ...makeMessage(2), type: 'error', content: 'Connection failed.' });
    if (kind === 'interrupted') messages.push({ ...makeMessage(2), type: 'assistant', isInterruptedNotice: true, content: 'Stopped.' });
    if (kind === 'no-final') messages.push({ ...makeMessage(2), type: 'assistant', isToolUse: true, toolName: 'Bash', toolInput: { command: 'pwd' }, content: '' });
    renderPane({ messages });
    expect(screen.getByText('Working details.')).toBeTruthy();
    const header = document.querySelector('[data-turn-process-header] button');
    if (header) expect(header.getAttribute('aria-expanded')).toBe('true');
  });

});

it('folds all intermediate prose and work in order while preserving the final output and disclosure state', async () => {
  const user: ChatMessage = { id: 'run-user', type: 'user', content: 'Check the implementation', timestamp: '2026-11-05T00:00:00Z' };
  const call: ChatMessage = { id: 'run-call', toolId: 'run-call', type: 'assistant', isToolUse: true,
    toolName: 'Read', toolInput: { file_path: 'sample.ts' }, toolResult: { content: 'First result' }, timestamp: user.timestamp };
  const progress: ChatMessage = { id: 'progress', type: 'assistant', content: 'First progress reply.', timestamp: user.timestamp };
  const second = { ...call, id: 'run-second', toolId: 'run-second', toolName: 'Bash', toolInput: { command: 'pwd' } };
  const live = [user, call, progress, second];
  const view = render(createPaneElement({ messages: live, isAssistantWorking: true }));
  const header = view.container.querySelector('[data-turn-process-header] button')!;
  const region = view.container.querySelector('[data-turn-process-region]')!;
  const prose = screen.getByText('First progress reply.');
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(view.container.querySelectorAll('[data-process-block]')).toHaveLength(2);
  const finished: ChatMessage[] = [...live, { id: 'final', type: 'assistant', content: 'Final answer.', timestamp: '2026-11-05T00:00:29Z' },
    { id: 'summary', type: 'system', isAgentActivitySummary: true, content: '', state: 'completed', durationMs: 29000, timestamp: '2026-11-05T00:00:29Z' }];
  view.rerender(createPaneElement({ messages: finished }));
  expect(view.container.querySelector('[data-turn-process-header] button')).toBe(header);
  expect(header.textContent).toBe('Processed 29s');
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(view.container.querySelector('[data-turn-process-region]')).toBe(region);
  expect(region.getAttribute('aria-hidden')).toBe('true');
  expect(region.hasAttribute('inert')).toBe(true);
  expect(screen.queryByRole('button', { name: /Explored 1 file|Ran 1 command/ })).toBeNull();
  expect(screen.getByText('First progress reply.')).toBe(prose);
  expect(prose.closest('[data-turn-process-region]')?.getAttribute('aria-hidden')).toBe('true');
  const final = await screen.findByText('Final answer.');
  expect(final.closest('[data-turn-process-output]')?.getAttribute('aria-hidden')).toBe('false');
  const controlled = header.getAttribute('aria-controls')!.split(' ');
  expect(controlled).toHaveLength(3);
  expect(controlled.every(id => document.getElementById(id)?.getAttribute('aria-hidden') === 'true')).toBe(true);
  fireEvent.click(header);
  expect(region.getAttribute('aria-hidden')).toBe('false');
  expect(screen.getByRole('button', { name: 'Explored 1 file' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ran 1 command' })).toBeTruthy();
  expect(prose.closest('[data-turn-process-region]')?.getAttribute('aria-hidden')).toBe('false');
  const order = Array.from(view.container.querySelectorAll('[data-turn-process-region]')).map(region => region.textContent);
  expect(order[0]).toContain('Explored 1 file');
  expect(order[1]).toContain('First progress reply.');
  expect(order[2]).toContain('Ran 1 command');
  expect(order[3]).toContain('Final answer.');
  view.rerender(createPaneElement({ messages: finished.map(message => ({ ...message })) }));
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('First progress reply.')).toBe(prose);
  view.rerender(createPaneElement({ messages: [...finished, { ...user, id: 'next-user', content: 'Continue' }], isAssistantWorking: true }));
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(view.container.querySelectorAll('[data-turn-process-header]')).toHaveLength(2);
});

describe('chat response reserved space', () => {
  it('reserves about half the viewport, clamped between 220 and 520', () => {
    expect(getChatResponseReserveTarget(0)).toBe(220);
    expect(getChatResponseReserveTarget(400)).toBe(220);
    expect(getChatResponseReserveTarget(800)).toBe(416);
    expect(getChatResponseReserveTarget(2000)).toBe(520);
  });

  it('reserves reply space only while the assistant is working', () => {
    expect(shouldKeepChatResponseReservedSpace(-1, false)).toBe(false);
    expect(shouldKeepChatResponseReservedSpace(0, true)).toBe(true);
    expect(shouldKeepChatResponseReservedSpace(0, false)).toBe(false);
    expect(shouldKeepChatResponseReservedSpace(2, false)).toBe(false);
    expect(shouldKeepChatResponseReservedSpace(2, true)).toBe(true);
  });

  it('renders the latest follow-up turn inside the reserved response area', () => {
    const { container } = renderPane({
      messages: [makeMessage(0), makeMessage(1), makeMessage(2), makeMessage(3)],
      isAssistantWorking: true,
    });

    const reservedArea = container.querySelector('[data-chat-response-reserved-space="true"]');
    expect(reservedArea).not.toBeNull();
    expect((reservedArea as HTMLElement).style.minHeight).toBe('220px');
    expect(within(reservedArea as HTMLElement).getByText('Message 3')).toBeTruthy();
    expect(within(reservedArea as HTMLElement).queryByText('Message 2')).toBeNull();
  });

  it('releases the reply reserve after completion instead of leaving a blank conversation tail', () => {
    const messages = [makeMessage(0), makeMessage(1), makeMessage(2), makeMessage(3)];
    const view = renderPane({ messages, isAssistantWorking: true });
    view.rerender(createPaneElement({ messages, isAssistantWorking: false }));
    expect(view.container.querySelector('[data-chat-response-reserved-space]')).toBeNull();
    expect((view.container.querySelector('.chat-current-turn-reserve') as HTMLElement).style.minHeight).toBe('0px');
  });
});


it('shows a provisional send without writing a duplicate transcript message on acceptance', () => {
  const pending = { id: 'send-1', status: 'submitting' as const, createdAt: new Date().toISOString(), displayText: 'My next message' };
  const view = renderPane({ messages: [], sendingInputs: [pending] });
  expect(screen.getAllByText('My next message')).toHaveLength(1);
  expect(view.container.querySelector('[data-sending-input="send-1"]')).toBeTruthy();
  view.rerender(createPaneElement({ messages: [{ type: 'user', runId: 'send-1', content: 'My next message', timestamp: pending.createdAt }], sendingInputs: [] }));
  expect(screen.getAllByText('My next message')).toHaveLength(1);
  expect(view.container.querySelector('[data-sending-input]')).toBeNull();
});


describe('uploaded image preview lifecycle', () => {
  it('keeps all same-name thumbnails mounted through canonical confirmation without duplicate preview downloads', async () => {
    const attachments = ['YQ==', 'Yg==', 'Yw=='].map((bytes, index) => ({ name: 'image.png', path: 'image.png', uploadId: 'multi-render', attachmentId: String(index), mimeType: 'image/png', previewData: `data:image/png;base64,${bytes}` }));
    const user: ChatMessage = { id: 'local', renderKey: 'stable-user', type: 'user', content: 'Compare', timestamp: new Date(), attachments };
    const view = renderPane({ messages: [user], isAssistantWorking: true });
    const original = screen.getAllByRole('img');
    expect(original).toHaveLength(3);
    const fetch = vi.spyOn(api, 'authenticatedFetch');
    view.rerender(createPaneElement({ messages: [{ ...user, id: 'persisted', attachments: attachments.map(attachmentDisplayMetadata), images: attachments.map(attachment => ({ name: '', data: attachment.previewData })) }] }));
    expect(screen.getAllByRole('img')).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it.each([false, true])('renders metadata-only uploads during generation and once after history (cold cache=%s)', async cold => {
    const preview = 'data:image/png;base64,cHJldmlldy1ieXRlcw==';
    const attachment = { name: 'upload.png', uploadId: `render-${cold}`, attachmentId: 'image', mimeType: 'image/png', previewData: preview };
    if (!cold) rememberUploadedPreview(attachment);
    const fetch = vi.spyOn(api, 'authenticatedFetch').mockResolvedValue({ ok: true, json: async () => ({ data: preview }) } as Response);
    try {
      const user: ChatMessage = { id: 'user', type: 'user', content: 'describe', timestamp: new Date(), attachments: [attachmentDisplayMetadata(attachment)] };
      const view = renderPane({ messages: [user], isAssistantWorking: true });
      if (!cold) expect(screen.getByRole('img').getAttribute('src')).toBe(preview);
      await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe(preview));
      expect(fetch).toHaveBeenCalledTimes(cold ? 1 : 0);
      if (cold) expect(fetch).toHaveBeenCalledWith('/api/uploads/render-true/attachments/image/preview', expect.objectContaining({ signal: expect.any(AbortSignal) }));
      view.rerender(createPaneElement({ messages: [{ ...user, images: [{ name: '', data: preview }] }] }));
      expect(screen.getAllByRole('img')).toHaveLength(1);
      expect(screen.queryByText('upload.png')).toBeNull();
    } finally { fetch.mockRestore(); }
  });

  it('shows images immediately during generation and only once when history arrives, keeping ordinary files', () => {
    const preview = 'data:image/png;base64,aW1hZ2U=';
    const user: ChatMessage = { id: 'local-image', type: 'user', content: 'Describe these', timestamp: new Date(),
      attachments: [
        { name: 'photo.png', uploadId: 'u1', attachmentId: 'a1', mimeType: 'image/png', previewData: preview },
        { name: 'notes.txt', mimeType: 'text/plain', size: 42 },
      ],
    };
    const view = renderPane({ messages: [user], isAssistantWorking: true });
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('src')).toBe(preview);
    expect(screen.queryByText('photo.png')).toBeNull();
    expect(screen.getByText('notes.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Preview photo.png' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    view.rerender(createPaneElement({ messages: [{ ...user, id: 'confirmed-image', images: [{ name: 'photo.png', data: preview }] }] }));
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.queryByText('photo.png')).toBeNull();
    expect(screen.getByText('notes.txt')).toBeTruthy();
  });
});

it('uploaded image stays visible when sent with a document region reference', () => {
  const uploadedPreview = 'data:image/png;base64,dXBsb2Fk';
  const regionData = 'data:image/png;base64,cmVnaW9u';
  const reference = { schemaVersion: 1 as const, kind: 'content-reference' as const,
    id: 'region-1', selectionMode: 'region' as const, createdAt: '2026-09-11T00:00:00Z',
    source: { fileName: 'reference.pdf', relativePath: 'reference.pdf', mimeType: 'application/pdf' },
    renderer: { id: 'pdf' as const, backend: 'builtin' as const, locatorQuality: 'visual' as const },
    locator: { surface: 'page' as const, pageNumber: 1, rect: { x: 0, y: 0, width: 1, height: 1 } },
    image: { name: 'region.png', mimeType: 'image/png' as const, width: 100, height: 100, dataUrl: regionData },
  };
  const messages = normalizedToChatMessages([{
    id: 'local-mixed', sessionId: 'web:test', provider: 'pilotdeck', kind: 'text', role: 'user',
    content: 'compare the uploaded image with this document region', timestamp: '2026-09-11T00:00:00Z',
    images: [regionData],
    attachments: [ { name: 'uploaded.png', uploadId: 'u', attachmentId: 'a', previewData: uploadedPreview },
      { kind: 'content-reference', name: reference.source.fileName, path: reference.source.relativePath, contentReference: { ...reference, image: { ...reference.image, dataUrl: undefined } } } ],
  }]);
  const view = renderPane({ messages, isAssistantWorking: true });
  expect(screen.getAllByRole('img').some(img => img.getAttribute('src') === uploadedPreview)).toBe(true);
  view.rerender(createPaneElement({ messages: [{ ...messages[0], images: [
    { name: '', data: regionData }, { name: '', data: uploadedPreview },
  ] }] }));
  expect(screen.getAllByRole('img').filter(img => img.getAttribute('src') === uploadedPreview)).toHaveLength(1);
});

it('shows a single read directly and renders its image only once', () => {
  const now = new Date().toISOString();
  const messages: ChatMessage[] = [
    { id: 'user', type: 'user', content: 'Read the image', timestamp: now },
    { id: 'image-call', type: 'assistant', isToolUse: true, toolId: 'image-call', toolName: 'read_file', toolInput: { file_path: 'preview.png' }, timestamp: now,
      toolResult: { content: '', images: [{ data: 'data:image/png;base64,aGVsbG8=', name: 'preview.png' }] } },
    { id: 'answer', type: 'assistant', content: 'Image inspected.', timestamp: now },
  ];
  renderPane({ messages });
  fireEvent.click(processToggle());
  expect(screen.getByText('Explored 1 file')).toBeTruthy();
  expect(screen.getAllByRole('img', { name: 'preview.png' })).toHaveLength(1);
  const toolButton = document.querySelector('.tool-call button[aria-expanded]') as HTMLButtonElement;
  expect(toolButton.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toolButton);
  expect(toolButton.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getAllByRole('img', { name: 'preview.png' })).toHaveLength(1);
});

function toolRegressionMessages(): ChatMessage[] {
  const timestamp = '2026-09-15T09:00:00.000Z';
  return [
    { id: 'reg-user', type: 'user', content: 'Inspect files', timestamp },
    { id: 'reg-read', type: 'assistant', content: '', timestamp, isToolUse: true,
      toolName: 'Read', toolId: 'reg-read', toolInput: { file_path: 'first.ts' },
      toolResult: { content: 'first file content' } },
  ];
}

it.each([true, false])('retains compaction next to a single tool (live=%s)', (live) => {
  const messages: ChatMessage[] = [
    ...toolRegressionMessages(),
    { id: 'reg-compact', type: 'system', content: '', timestamp: '2026-09-15T09:00:01.000Z',
      isCompactBoundary: true, compactionId: 'reg-compact', compactState: live ? 'running' : 'completed' },
  ];
  if (!live) messages.push({ id: 'compact-answer', type: 'assistant', content: 'Continuing after compaction', timestamp: '2026-09-15T09:00:02.000Z' });
  renderPane({ messages, isAssistantWorking: live });
  if (!live) fireEvent.click(processToggle());
  expect(within(document.querySelector('[data-turn-trace]') as HTMLElement).getByText(live ? 'Compacting context...' : /Compacted context/)).toBeTruthy();
});

it.each([false, true])('preserves an inherited group toggle independently through completion (close parent=%s)', (closeParent) => {
  const base = toolRegressionMessages();
  const view = renderPane({ messages: base, isAssistantWorking: true });
  fireEvent.click(screen.getByRole('button', { name: /first\.ts$/ }));
  const grouped: ChatMessage[] = [...base, {
    ...base[1], id: 'reg-read-2', toolId: 'reg-read-2', toolInput: { file_path: 'second.ts' },
    toolResult: { content: 'second file content' },
  }];
  view.rerender(createPaneElement({ messages: grouped, isAssistantWorking: true }));
  const groupToggle = processToggle();
  expect(groupToggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /first\.ts$/, expanded: true }));
  expect(groupToggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: /second\.ts$/ })).toBeTruthy();
  // A later child update must not reopen a manually closed parent.
  if (closeParent) fireEvent.click(groupToggle);
  view.rerender(createPaneElement({ messages: [...grouped], isAssistantWorking: true }));
  expect(processToggle().getAttribute('aria-expanded')).toBe(String(!closeParent));
  view.rerender(createPaneElement({ messages: [...grouped, {
    id: 'reg-answer', type: 'assistant', content: 'Inspection complete', timestamp: '2026-09-15T09:00:02.000Z',
  }] }));
  expect(processToggle().getAttribute('aria-expanded')).toBe(String(!closeParent));
  if (closeParent) fireEvent.click(processToggle());
  expect(processToggle().getAttribute('aria-expanded')).toBe('true');
  {
    expect(screen.getByRole('button', { name: /first\.ts$/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: /second\.ts$/ })).toBeTruthy();
  }
});

it('shows a static answer-waiting state instead of a running timer and resumes after answering', () => {
  vi.useFakeTimers();
  try {
    const messages: ChatMessage[] = [{id:'wait-user',type:'user',content:'Ask a question',timestamp:new Date().toISOString()}];
    const pendingPermissionRequests = [{requestId:'q1',toolName:'AskUserQuestion',receivedAt:new Date()}];
    const view = renderPane({messages,isAssistantWorking:true,pendingPermissionRequests});
    expect(screen.queryByText(/Waiting for your answer|等待你回答/)).toBeNull();
    expect(screen.queryByText(/Processed \d|已处理 \d/)).toBeNull();
    expect(view.container.querySelector('.animate-spin')).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText(/Processed \d|已处理 \d/)).toBeNull();
    view.rerender(createPaneElement({messages,isAssistantWorking:true}));
    expect(screen.queryByText(/Waiting for your answer|等待你回答/)).toBeNull();
    expect(screen.getByText(/Processed \d|已处理 \d/)).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

it('reveals one file card at the turn tail after trailing tools, outside all process folds', () => {
  const artifacts: NonNullable<ChatMessage['artifacts']> = [{ id: 'report', name: 'report.txt', path: 'report.txt',
    operation: 'created', source: 'workspace_diff', status: 'incomplete', size: 42, sha256: 'a'.repeat(64), createdAt: '2026-11-01T00:00:00Z' }];
  const messages: ChatMessage[] = [
    { id: 'user-files', type: 'user', content: 'Create a report', timestamp: '2026-11-01T00:00:00Z' },
    { id: 'progress-files', type: 'assistant', content: 'Checking the generated report.', timestamp: '2026-11-01T00:00:01Z', turnId: 'files-turn', artifacts },
    { id: 'verify-files', type: 'assistant', content: '', turnId: 'files-turn', isToolUse: true,
      timestamp: '2026-11-01T00:00:02Z', toolName: 'run_command', toolId: 'verify-files', toolInput: { command: 'verify report.txt' }, toolResult: { content: 'ok' } },
  ];
  const view = renderPane({ messages, isAssistantWorking: true });
  expect(screen.queryByTestId('turn-changes-card')).toBeNull();
  view.rerender(createPaneElement({ messages }));
  const card = screen.getByTestId('turn-changes-card');
  const trailingWork = view.container.querySelector('[data-process-block]')!;
  expect(trailingWork.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card.closest('[data-turn-process-region], [data-process-block]')).toBeNull();
  const finished: ChatMessage[] = [...messages, { id: 'final-files', type: 'assistant', content: 'Report complete.', timestamp: '2026-11-01T00:00:03Z', turnId: 'files-turn' }];
  view.rerender(createPaneElement({ messages: finished }));
  expect(screen.getAllByTestId('turn-changes-card')).toHaveLength(1);
  const finalReply = screen.getByText('Report complete.');
  const fileCard = screen.getByTestId('turn-changes-card');
  expect(finalReply.compareDocumentPosition(fileCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const turnToggle = view.container.querySelector<HTMLButtonElement>('[data-turn-process-header] button')!;
  expect(turnToggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(turnToggle);
  expect(screen.getAllByTestId('turn-changes-card')).toHaveLength(1);
  expect(fileCard.closest('[aria-hidden="true"]')).toBeNull();
});

it('keeps partial files accessible when a stopped turn has no prose reply', () => {
  const messages = normalizedToChatMessages([{ id: 'partial-files', sessionId: 'partial', provider: 'pilotdeck',
    kind: 'file_artifacts', runId: 'partial-turn', timestamp: '2026-11-01T00:00:00Z', artifacts: [{
      id: 'partial-report', name: 'partial.txt', path: 'partial.txt', operation: 'created', source: 'workspace_diff',
      status: 'incomplete', size: 42, sha256: 'a'.repeat(64), createdAt: '2026-11-01T00:00:00Z',
    }] }]);
  const view = renderPane({ messages });
  expect(screen.getAllByTestId('turn-changes-card')).toHaveLength(1);
  expect(view.container.querySelector('[data-turn-file="partial.txt"]')).toBeTruthy();
  expect(view.container.querySelector('[data-testid="assistant-message-actions"]')).toBeNull();
});

it('places checkpoint-only changes at the tail and preserves incomplete-turn review', async () => {
  const changes = [{ path: 'report.txt', operation: 'created', source: 'file_tool', added: 2, removed: 0, restorable: true, binary: false }];
  const fetch = vi.spyOn(api, 'authenticatedFetch').mockResolvedValue({ ok: true, json: async () => ({
    checkpoints: [{ id: 'files-checkpoint', phase: 'after', turnId: 'checkpoint-turn', status: 'incomplete', changes }],
    sessionChanges: changes, operations: [], busy: false,
  }) } as Response);
  const messages: ChatMessage[] = [
    { id: 'checkpoint-prose', type: 'assistant', content: 'Verifying the page.', timestamp: '2026-11-01T00:00:00Z', turnId: 'checkpoint-turn' },
    { id: 'checkpoint-tool', type: 'assistant', content: '', isToolUse: true, toolId: 'checkpoint-tool',
      timestamp: '2026-11-01T00:00:01Z', toolName: 'bash', toolInput: { command: 'verify report.txt' }, toolResult: { content: 'ok' }, turnId: 'checkpoint-turn' },
  ];
  const element = (running: boolean) => <ChatReviewProvider project={{ name: 'workspace', displayName: 'Workspace', fullPath: '/workspace' }}
    session={{ id: 'files-session' }} onOpen={() => {}}>{createPaneElement({ messages, isAssistantWorking: running })}</ChatReviewProvider>;
  try {
    const view = render(element(true));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('turn-changes-card')).toBeNull();
    view.rerender(element(false));
    const card = await screen.findByTestId('turn-changes-card');
    const work = view.container.querySelector('[data-process-block]')!;
    expect(work.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getByText('本轮执行未完成，已记录可用的文件变更')).toBeTruthy();
    expect(within(card).getByRole('button', { name: '查看变更' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: '撤销' }).hasAttribute('disabled')).toBe(false);
  } finally { fetch.mockRestore(); }
});

it.each(['generate_image', 'edit_image', 'generate_video'])('keeps pending intermediate %s animation outside folded work, then retires it', async toolName => {
  const now = '2026-11-01T00:00:00Z';
  const user: ChatMessage = { id: 'media-user', type: 'user', content: 'Create a site asset', timestamp: now };
  const call: ChatMessage = { id: 'asset-call', toolId: 'asset-call', type: 'assistant', content: '', timestamp: now,
    isToolUse: true, toolName, toolInput: { purpose: 'intermediate', output_path: 'assets/example.png', prompt: 'A small site asset' } };
  const view = renderPane({ messages: [user, call], isAssistantWorking: true });
  const surface = view.container.querySelector('.generated-image-surface')!;
  expect(surface.getAttribute('aria-busy')).toBe('true');
  expect(surface.closest('[data-turn-process-region], [data-process-block]')).toBeNull();
  fireEvent.click(view.container.querySelector('[data-turn-process-header] button')!);
  expect(surface.closest('[aria-hidden="true"]')).toBeNull();
  const result = toolName === 'generate_video'
    ? { videoGeneration: { videoId: 'video-1', sessionId: 'session-1', purpose: 'intermediate' } }
    : { imageGeneration: { imageId: 'image-1', sessionId: 'session-1', purpose: 'intermediate', width: 24, height: 16, mimeType: 'image/png' } };
  view.rerender(createPaneElement({ messages: [user, { ...call, toolResult: { content: 'Done', toolUseResult: result } },
    { id: 'asset-answer', type: 'assistant', content: 'Site complete.', timestamp: now }] }));
  expect(surface.closest('[data-media-surface]')?.getAttribute('aria-hidden')).toBe('true');
  await waitFor(() => expect(view.container.querySelector('.generated-image-surface')).toBeNull());
  expect(view.container.querySelector('video, img')).toBeNull();
});

it.each(['generate_image', 'edit_image'])('does not restart historical unfinished %s feedback in a later turn', toolName => {
  const messages: ChatMessage[] = [
    { id: 'old-media', type: 'assistant', content: '', timestamp: '2026-11-01T00:00:00Z', isToolUse: true,
      toolId: 'old-media', toolName, toolInput: { purpose: 'deliverable' } },
    { id: 'next-media-user', type: 'user', content: 'Continue with another task', timestamp: '2026-11-01T00:01:00Z' },
  ];
  const view = renderPane({ messages, isAssistantWorking: true });
  expect(view.container.querySelector('.generated-image-surface')).toBeNull();
});

it('shows a model-call spinner between completed tools and the next model output', () => {
  const now = '2026-11-01T00:00:00Z';
  const user: ChatMessage = { id: 'model-user', type: 'user', content: 'Inspect a file', timestamp: now };
  const call: ChatMessage = { id: 'model-tool', toolId: 'model-tool', type: 'assistant', content: '', timestamp: now,
    isToolUse: true, toolName: 'bash', toolInput: { command: 'verify example.txt' } };
  const thought: ChatMessage = { id: 'model-thought', type: 'assistant', content: 'Check the result.', timestamp: now, isThinking: true };
  const view = renderPane({ messages: [user, call], isAssistantWorking: true });
  const status = () => view.container.querySelector('[data-process-status="live-model-call"]');
  expect(status()).toBeNull();
  const finished = { ...call, toolResult: { content: '', isError: false } };
  view.rerender(createPaneElement({ messages: [user, finished, thought], isAssistantWorking: true }));
  expect(status()?.textContent).toContain('Calling model...');
  expect(status()?.querySelector('svg')?.getAttribute('class')).toContain('motion-safe:animate-spin');
  // Another tool or real model output replaces the fallback rather than duplicating it.
  view.rerender(createPaneElement({ messages: [user, finished, { ...thought, isStreaming: true }], isAssistantWorking: true }));
  expect(status()).toBeNull();
  const reply: ChatMessage = { id: 'model-reply', type: 'assistant', content: 'The result is ready.', timestamp: now, isStreaming: true };
  view.rerender(createPaneElement({ messages: [user, finished, thought, reply], isAssistantWorking: true }));
  expect(status()).toBeNull();
  view.rerender(createPaneElement({ messages: [user, finished, thought, { ...reply, isStreaming: false }], isAssistantWorking: true,
    pendingPermissionRequests: [{ requestId: 'model-question', toolName: 'AskUserQuestion', receivedAt: new Date() }] }));
  expect(status()).toBeNull();
  view.rerender(createPaneElement({ messages: [user, finished, thought] }));
  expect(status()).toBeNull();
});

it('retains manually inspected tools and their ancestors after new prose and completion', () => {
  const messages = toolRegressionMessages();
  const view = renderPane({ messages, isAssistantWorking: true });
  const tool = screen.getByRole('button', { name: /first\.ts$/ });
  fireEvent.click(tool);
  const group = view.container.querySelector('[data-process-block] > button')!;
  const turn = view.container.querySelector('[data-turn-process-header] button')!;
  view.rerender(createPaneElement({ messages: [...messages, { id: 'inspection-reply', type: 'assistant',
    content: 'The file is ready.', timestamp: '2026-09-15T09:00:02Z' }] }));
  expect(tool.getAttribute('aria-expanded')).toBe('true');
  expect(group.getAttribute('aria-expanded')).toBe('true');
  expect(turn.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(tool);
  view.rerender(createPaneElement({ messages: [...messages, { id: 'inspection-reply', type: 'assistant',
    content: 'The file is ready. Another update.', timestamp: '2026-09-15T09:00:02Z' }] }));
  expect(tool.getAttribute('aria-expanded')).toBe('false');
});

it('clears deliberate tool and thinking openings when the next user message arrives', () => {
  const messages = toolRegressionMessages();
  const thought: ChatMessage = { id: 'previous-thought', type: 'assistant', isThinking: true,
    content: 'Reasoning from the previous turn.', timestamp: messages[0].timestamp };
  const finished: ChatMessage[] = [...messages, thought, { id: 'previous-final', type: 'assistant',
    content: 'The previous result.', timestamp: messages[0].timestamp }];
  const view = renderPane({ messages: finished });
  fireEvent.click(view.container.querySelector('[data-turn-process-header] button')!);
  fireEvent.click(view.container.querySelector('[data-process-block] > button')!);
  fireEvent.click(view.container.querySelector('.tool-call button')!);
  fireEvent.click(view.container.querySelector('[data-thinking-state] > button')!);
  view.rerender(createPaneElement({ messages: [...finished, { id: 'next-input', type: 'user',
    content: 'Continue with a new task.', timestamp: messages[0].timestamp }], isAssistantWorking: true }));
  const oldTurn = view.container.querySelector('[data-turn-process-header] button')!;
  expect(oldTurn.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(oldTurn);
  const oldProcess = view.container.querySelector('[data-process-block] > button')!;
  expect(oldProcess.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(oldProcess);
  expect(view.container.querySelector('.tool-call button')!.getAttribute('aria-expanded')).toBe('false');
  expect(view.container.querySelector('[data-thinking-state] > button')!.getAttribute('aria-expanded')).toBe('false');
});

it('removes the previous file card on submission and shows only the latest completed turn files', () => {
  const artifacts: NonNullable<ChatMessage['artifacts']> = [{ id: 'old-file', name: 'old.txt', path: 'old.txt',
    operation: 'created', source: 'workspace_diff', status: 'complete', size: 42,
    sha256: 'a'.repeat(64), createdAt: '2026-11-01T00:00:00Z' }];
  const messages: ChatMessage[] = [makeMessage(0), { ...makeMessage(1), turnId: 'old-turn', artifacts }];
  const view = renderPane({ messages });
  expect(screen.getAllByTestId('turn-changes-card')).toHaveLength(1);
  view.rerender(createPaneElement({ messages, sendingInputs: [{ id: 'sending', displayText: 'Continue',
    createdAt: '2026-11-01T00:01:00Z', status: 'submitting' }] }));
  expect(screen.queryByTestId('turn-changes-card')).toBeNull();
  const next: ChatMessage[] = [...messages, { ...makeMessage(2), id: 'next-turn-user' }];
  view.rerender(createPaneElement({ messages: next, isAssistantWorking: true }));
  expect(screen.queryByTestId('turn-changes-card')).toBeNull();
  view.rerender(createPaneElement({ messages: [...next, { ...makeMessage(3), turnId: 'new-turn',
    artifacts: [{ ...artifacts[0], id: 'new-file', name: 'new.txt', path: 'new.txt' }] }] }));
  expect(screen.getAllByTestId('turn-changes-card')).toHaveLength(1);
  expect(screen.getByTestId('turn-changes-card').textContent).toContain('new.txt');
  expect(screen.getByTestId('turn-changes-card').textContent).not.toContain('old.txt');
});
