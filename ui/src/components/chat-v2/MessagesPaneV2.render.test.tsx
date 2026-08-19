// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FindShortcutProvider } from '../../contexts/FindShortcutContext';
import type { ChatMessage, ChatRunMode, SessionRuntimeState } from '../chat/types/types';
import MessagesPaneV2 from './MessagesPaneV2';
import { getContextStatus } from './ComposerV2';

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
});

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
  isAssistantWorking = false,
  sessionRuntimeState = 'synchronizing',
  activeRunId = null,
  runMode = 'agent',
  planModeActive = false,
}: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  isAssistantWorking?: boolean;
  sessionRuntimeState?: SessionRuntimeState;
  activeRunId?: string | null;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
}) {
  const scrollContainerRef = React.createRef<HTMLDivElement>();

  return (
    <FindShortcutProvider activeScope="chat">
      <MessagesPaneV2
        scrollContainerRef={scrollContainerRef}
        onWheel={() => {}}
        onTouchMove={() => {}}
        isLoadingSessionMessages={false}
        chatMessages={messages}
        activityMessages={activityMessages}
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
        sessionRuntimeState={sessionRuntimeState}
        activeRunId={activeRunId}
        runMode={runMode}
        planModeActive={planModeActive}
      />
    </FindShortcutProvider>
  );
}

function renderPane(options: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  isAssistantWorking?: boolean;
  sessionRuntimeState?: SessionRuntimeState;
  activeRunId?: string | null;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
}) {
  return render(createPaneElement(options));
}

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
      <MessagesPaneV2
        scrollContainerRef={scrollContainerRef}
        onWheel={() => {}}
        onTouchMove={() => {}}
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

describe('MessagesPaneV2 render behavior', () => {
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

    expect(container.querySelector('[data-total-message-count]')?.getAttribute('data-total-message-count')).toBe('0');
    expect(screen.getByText('Reading Orphaned-3.tsx')).toBeTruthy();
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
        detail: 'MessagesPaneV2.tsx',
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
        phase: 'tool',
        state: 'running',
        title: 'Reading file',
        startedAt: now,
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    expect(screen.queryByText('HiddenTool.tsx')).toBeNull();

    const liveStatus = screen.getByText('Reading file').closest('[role="status"]');
    expect(liveStatus).not.toBeNull();
    if (!liveStatus) throw new Error('Expected live status container');
    const expandButton = liveStatus.querySelector('button');
    expect(expandButton).not.toBeNull();
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');

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

    const summary = screen.getByText(/Ran 1 command.*1 error/);
    const button = summary.closest('button');
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLButtonElement);

    expect(screen.getByText(/find \. -maxdepth 1 -type f/)).toBeTruthy();
    expect(screen.queryByText('Parameters')).toBeNull();
    expect(container.querySelector('.border-l-red-500')).toBeNull();
    expect(screen.queryByRole('button', { name: /permissions\.grant|Grant Bash for this chat/ })).toBeNull();

    const errorSummary = screen.getByText('Tool error').closest('summary');
    expect(errorSummary).not.toBeNull();
    const details = errorSummary?.closest('details') as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
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

    const liveStatus = screen.getByText('Reading ReadHidden.tsx').closest('[role="status"]');
    expect(liveStatus).not.toBeNull();
    if (!liveStatus) throw new Error('Expected live status container');
    const expandButton = liveStatus.querySelector('button');
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

    const updatedStatus = screen.getByText('Searching Footer').closest('[role="status"]');
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

    const liveStatus = screen.getByText('Reading ReadHidden.tsx').closest('[role="status"]');
    expect(liveStatus).not.toBeNull();
    if (!liveStatus) throw new Error('Expected live status container');
    const expandButton = liveStatus.querySelector('button');
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

    const summary = screen.getByText('Explored 1 file');
    const completedButton = summary.closest('button');
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

    const processButton = container.querySelector<HTMLButtonElement>('.process-live-status button');
    expect(processButton).not.toBeNull();
    fireEvent.click(processButton as HTMLButtonElement);

    const parametersSummary = screen.getByText('Parameters').closest('summary');
    const parametersDetails = parametersSummary?.closest('details') as HTMLDetailsElement | null;
    expect(parametersDetails?.open).toBe(false);
    fireEvent.click(parametersSummary as HTMLElement);
    await waitFor(() => expect(parametersDetails?.open).toBe(true));

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

    const completedProcessButton = screen.getByText('Ran 1 command').closest('button');
    expect(completedProcessButton?.getAttribute('aria-expanded')).toBe('true');
    const persistedParameters = screen.getByText('Parameters').closest('details') as HTMLDetailsElement | null;
    expect(persistedParameters?.open).toBe(true);
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
        toolResult: { content: 'ok', isError: false },
      },
      {
        id: 'a-1',
        type: 'assistant',
        content: 'Done.',
        timestamp: now,
      },
    ];

    renderPane({ messages });

    const summary = screen.getByText('Explored 1 file');
    const processButton = summary.closest('button');
    expect(processButton?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('SearchHiddenNeedle.tsx')).toBeNull();

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    const search = screen.getByRole('search');
    const input = search.querySelector('input[type="search"]') as HTMLInputElement | null;
    if (!input) throw new Error('Expected chat search input');
    fireEvent.change(input, { target: { value: 'SearchHiddenNeedle.tsx' } });

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
    const firstStatus = screen.getByText('Explored 1 file');
    const secondAssistant = screen.getByText('Now I will verify the build.');
    const runningStatus = screen.getByText('Running npm run build');

    expect(Boolean(firstAssistant.compareDocumentPosition(firstStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(firstStatus.compareDocumentPosition(secondAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(secondAssistant.compareDocumentPosition(runningStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    expect(screen.queryByText('FirstHidden.tsx')).toBeNull();
    const firstStatusContainer = firstStatus.closest('[role="status"]');
    expect(firstStatusContainer).not.toBeNull();
    if (!firstStatusContainer) throw new Error('Expected first inline status container');
    expect(firstStatusContainer.parentElement?.className).toContain('mt-2');
    expect(firstStatusContainer.parentElement?.className).toContain('gap-2');
    const expandButton = firstStatusContainer.querySelector('button');
    expect(expandButton).not.toBeNull();

    fireEvent.click(expandButton as HTMLButtonElement);

    expect(screen.getByText('FirstHidden.tsx')).toBeTruthy();
    expect(firstAssistant.closest('.chat-message')?.className).toContain('pb-2');
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

    const firstAssistant = screen.getByText('I will inspect first.');
    const readSummary = screen.getByText('Explored 1 file');
    const secondAssistant = screen.getByText('Now I will run checks.');
    const commandSummary = screen.getByText('Ran 1 command');
    const finalAssistant = screen.getByText('All done.');

    expect(Boolean(firstAssistant.compareDocumentPosition(readSummary) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(readSummary.compareDocumentPosition(secondAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(secondAssistant.compareDocumentPosition(commandSummary) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(commandSummary.compareDocumentPosition(finalAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('shows generating status after a closed live tool group while the assistant continues', () => {
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

    expect(screen.getByText('Explored 1 file')).toBeTruthy();
    expect(screen.getByText('Generating response')).toBeTruthy();
    expect(screen.queryByText('Reading file')).toBeNull();
  });

  it('folds ordinary failed tools into a compact process row with error count', () => {
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

    expect(screen.queryByText('Tool error')).toBeNull();
    expect(screen.queryByText('FailedTool.tsx')).toBeNull();

    const summary = screen.getByText(/Edited 1 file.*Searched 1 time.*2 errors/);
    const button = summary.closest('button');
    expect(button).not.toBeNull();
    expect(button?.className).toContain('inline-flex');
    expect(button?.className).toContain('items-center');
    expect(button?.className).toContain('text-[14px]');
    expect(button?.className).toContain('leading-relaxed');
    expect(button?.closest('.process-trace')?.className).not.toContain('my-');

    fireEvent.click(button as HTMLButtonElement);

    expect(screen.getByText('FailedTool.tsx')).toBeTruthy();
    expect(screen.getAllByText('Tool error').length).toBeGreaterThan(0);
    expect(container.querySelector('.border-l-red-500')).toBeNull();
  });

  it('shows a waiting status below an in-progress web_fetch in plan mode', () => {
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

    expect(screen.getByText('Fetching web content...')).toBeTruthy();
  });

  it('does not show the web_fetch waiting status in agent mode', () => {
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

    expect(screen.queryByText('Fetching web content...')).toBeNull();
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
    expect(screen.queryByText('Compacted context')).toBeNull();
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

    renderPane({ messages });

    expect(screen.getByText('First assistant line.').closest('.chat-message')?.className).toContain('pb-4');
    expect(screen.getByText('First assistant line.').closest('.chat-message')?.className).not.toContain('pb-8');
  });
});
