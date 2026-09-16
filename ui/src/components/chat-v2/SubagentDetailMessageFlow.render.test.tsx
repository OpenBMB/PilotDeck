// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../i18n/testInstance';
import { normalizedToChatMessages } from '../chat/hooks/useChatMessages';
import { FindShortcutProvider } from '../../contexts/FindShortcutContext';
import type { ChatMessage } from '../chat/types/types';
import SubagentDetailMessageFlow from './SubagentDetailMessageFlow';

const baseTime = Date.parse('2026-05-18T08:00:00.000Z');

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
    window.setTimeout(() => callback(performance.now()), 0)
  ));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
});

function timestamp(offsetMs: number): string {
  return new Date(baseTime + offsetMs).toISOString();
}

function assistant(id: string, content: string, offsetMs = 100): ChatMessage {
  return {
    id,
    type: 'assistant',
    content,
    timestamp: timestamp(offsetMs),
  };
}

function thinking(id: string, content: string, offsetMs = 200): ChatMessage {
  return {
    id,
    type: 'assistant',
    content,
    timestamp: timestamp(offsetMs),
    isThinking: true,
  };
}

function streamingThinking(content: string, offsetMs = 200): ChatMessage {
  return {
    id: '__subagent_thinking_session-1_subagent-1',
    type: 'assistant',
    content,
    timestamp: timestamp(offsetMs),
    isThinking: true,
    isStreaming: true,
  };
}

function tool(id: string, toolName: string, offsetMs = 300): ChatMessage {
  return {
    id,
    type: 'assistant',
    content: '',
    timestamp: timestamp(offsetMs),
    isToolUse: true,
    toolId: id,
    toolName,
    toolInput: JSON.stringify({ file_path: '/repo/src/App.tsx' }),
    toolResult: null,
  };
}

function renderFlow(messages: ChatMessage[], isRunning = true) {
  return render(
    <FindShortcutProvider activeScope="chat">
      <SubagentDetailMessageFlow
        messages={messages}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
        showThinking
        isRunning={isRunning}
      />
    </FindShortcutProvider>,
  );
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('SubagentDetailMessageFlow', () => {
  it('renders streaming subagent thinking once before the tool status', async () => {
    renderFlow([
      assistant('a-1', 'I will edit the file.', 100),
      streamingThinking('Choose the smallest patch.', 200),
      tool('edit-1', 'Edit', 300),
    ]);

    const thinkingText = await screen.findByText('Choose the smallest patch.');
    const status = screen.getByRole('status');

    expect(screen.getAllByText('Choose the smallest patch.')).toHaveLength(1);
    expect(Boolean(thinkingText.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('renders completed standalone subagent thinking once', () => {
    renderFlow([
      assistant('a-1', 'I will inspect the issue.', 100),
      thinking('think-1', 'Standalone thought one.', 200),
      thinking('think-2', 'Standalone thought two.', 300),
    ], false);

    expect(screen.getAllByText('Standalone thought one.')).toHaveLength(1);
    expect(screen.getAllByText('Standalone thought two.')).toHaveLength(1);
  });

  it('keeps completed subagent thinking in its own rows outside tool status details', () => {
    renderFlow([
      assistant('a-1', 'I will inspect the issue.', 100),
      thinking('think-1', 'Completed thought one.', 200),
      thinking('think-2', 'Completed thought two.', 300),
      tool('read-1', 'Read', 400),
    ], false);

    expect(screen.getAllByRole('button', { name: /Thought process|思考过程/i })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Explored 1 file|已探索 1 个文件/i }));

    const status = screen.getByRole('status');
    const processRow = status.closest('.process-live-status');

    expect(screen.getAllByText('Completed thought one.')).toHaveLength(1);
    expect(screen.getAllByText('Completed thought two.')).toHaveLength(1);
    expect(processRow?.textContent).not.toContain('Completed thought one.');
    expect(processRow?.textContent).not.toContain('Completed thought two.');
    expect(status.textContent).not.toContain('Completed thought one.');
    expect(status.textContent).not.toContain('Completed thought two.');
    expect(screen.queryByText('Thought through next step')).toBeNull();
    expect(screen.getByText(/Explored 1 file|已探索 1 个文件/i)).toBeTruthy();
  });

  it('opens local search and highlights subagent message content', async () => {
    const overlay = document.createElement('div');
    overlay.dataset.modalOverlay = '';
    document.body.appendChild(overlay);

    renderFlow([
      assistant('a-1', 'First Needle appears here.', 100),
      assistant('a-2', 'Second Needle appears here.', 200),
    ], false);

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    const search = screen.getByRole('search');
    const input = search.querySelector('input[type="search"]') as HTMLInputElement | null;
    if (!input) throw new Error('Expected subagent search input');

    fireEvent.change(input, { target: { value: 'needle' } });

    await waitFor(() => {
      const activeMark = document.querySelector('mark.chat-history-search-highlight-active');
      expect(activeMark?.textContent?.toLowerCase()).toBe('needle');
    });
  });
});


it('passes subagent lifecycle state to normalized tool cards and updates it without new messages', async () => {
  const i18n = await createTestI18n();
  const messages = normalizedToChatMessages([{
    id: 'subagent-bash', sessionId: 'web:subagent-test', provider: 'pilotdeck',
    kind: 'tool_use', role: 'assistant', toolId: 'subagent-bash', toolName: 'bash',
    toolInput: { command: 'pnpm build', description: 'Build app' }, timestamp: timestamp(300),
  }]);
  const pane = (isRunning: boolean, items = messages) => (
    <I18nextProvider i18n={i18n}>
      <FindShortcutProvider activeScope="chat">
        <SubagentDetailMessageFlow messages={items} provider="pilotdeck" selectedProject={null}
          createDiff={() => []} isRunning={isRunning} />
      </FindShortcutProvider>
    </I18nextProvider>
  );
  const view = render(pane(true));
  fireEvent.click(view.container.querySelector('.process-live-status button[aria-expanded]') as HTMLButtonElement);
  fireEvent.click(view.container.querySelector('.tool-call button[aria-expanded]') as HTMLButtonElement);
  expect(screen.getByRole('button', { name: 'Running Build app' })).toBeTruthy();
  expect(screen.getAllByText('Running…').length).toBeGreaterThan(0);
  expect(screen.queryByText('No result recorded')).toBeNull();

  // Ending the subagent without a tool result must stop claiming execution.
  view.rerender(pane(false));
  expect(screen.getAllByText('No result recorded').length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'Running Build app' })).toBeNull();

  // Same message reference: this also detects a stale rendering callback.
  view.rerender(pane(true));
  expect(screen.getByRole('button', { name: 'Running Build app' })).toBeTruthy();
  expect(screen.queryByText('No result recorded')).toBeNull();

  view.rerender(pane(true, messages.map(message => ({
    ...message, toolResult: { content: 'Build complete.', isError: false },
  }))));
  expect(screen.getByRole('button', { name: 'Ran Build app' })).toBeTruthy();
  expect(screen.getByText('Build complete.')).toBeTruthy();
  expect(screen.getByText('Success')).toBeTruthy();
  expect(screen.queryByText('Running…')).toBeNull();
});
