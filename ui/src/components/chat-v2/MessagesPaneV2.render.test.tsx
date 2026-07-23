// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatRunMode } from '../chat/types/types';
import MessagesPaneV2 from './MessagesPaneV2';

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
  runMode = 'agent',
  planModeActive = false,
}: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  isAssistantWorking?: boolean;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
}) {
  const scrollContainerRef = React.createRef<HTMLDivElement>();

  return (
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
      runMode={runMode}
      planModeActive={planModeActive}
    />
  );
}

function renderPane(options: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  isAssistantWorking?: boolean;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
}) {
  return render(createPaneElement(options));
}

describe('MessagesPaneV2 render behavior', () => {
  it('renders only the viewport window for large conversations', () => {
    const messages = Array.from({ length: 220 }, (_, index) => makeMessage(index));

    renderPane({ messages });

    const container = screen.getByText('Message 0').closest('[data-total-message-count]');
    expect(container?.getAttribute('data-virtualized-messages')).toBe('true');
    expect(container?.getAttribute('data-total-message-count')).toBe('220');
    expect(Number(container?.getAttribute('data-rendered-message-count'))).toBeLessThan(220);
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

    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    scrollTo.mockClear();
    setScrollTop.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({
      behavior: 'smooth',
    })));
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
