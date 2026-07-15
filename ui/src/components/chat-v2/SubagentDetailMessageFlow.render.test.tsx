// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import SubagentDetailMessageFlow from './SubagentDetailMessageFlow';

const baseTime = Date.parse('2026-05-18T08:00:00.000Z');

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
    <SubagentDetailMessageFlow
      messages={messages}
      provider="pilotdeck"
      selectedProject={null}
      createDiff={() => []}
      showThinking
      isRunning={isRunning}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('SubagentDetailMessageFlow', () => {
  it('renders streaming subagent thinking through the live preview channel', () => {
    renderFlow([
      assistant('a-1', 'I will edit the file.', 100),
      streamingThinking('Choose the smallest patch.', 200),
      tool('edit-1', 'Edit', 300),
    ]);

    const thinkingText = screen.getByText('Choose the smallest patch.');
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

  it('keeps completed subagent thinking inside related tool status details', () => {
    renderFlow([
      assistant('a-1', 'I will inspect the issue.', 100),
      thinking('think-1', 'Completed thought one.', 200),
      thinking('think-2', 'Completed thought two.', 300),
      tool('read-1', 'Read', 400),
    ], false);

    expect(screen.queryByText('Completed thought one.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Explored 1 file|已探索 1 个文件/i }));

    const status = screen.getByRole('status');

    expect(screen.getAllByText('Completed thought one.')).toHaveLength(1);
    expect(screen.getAllByText('Completed thought two.')).toHaveLength(1);
    expect(status.textContent).toContain('Completed thought one.');
    expect(status.textContent).toContain('Completed thought two.');
    expect(screen.queryByText('Thought through next step')).toBeNull();
    expect(screen.getByText(/Explored 1 file|已探索 1 个文件/i)).toBeTruthy();
  });
});
