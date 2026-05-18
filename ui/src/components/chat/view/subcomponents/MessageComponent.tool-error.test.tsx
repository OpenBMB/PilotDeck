// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../types/types';
import MessageComponent from './MessageComponent';

afterEach(() => {
  cleanup();
});

function renderToolMessage(message: ChatMessage) {
  return render(
    <MessageComponent
      message={message}
      prevMessage={null}
      createDiff={() => []}
      provider="pilotdeck"
      onShowSettings={() => {}}
    />,
  );
}

describe('MessageComponent tool errors', () => {
  it('renders recoverable tool_use_error as a compact cleaned error row', () => {
    renderToolMessage({
      id: 'tool-1',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'write_file',
      toolId: 'tool-1',
      toolInput: '{"file_path":"","content":""}',
      toolResult: {
        isError: true,
        content: '<tool_use_error>InputValidationError: write_file failed: file_path is missing</tool_use_error>',
        errorCode: 'tool_execution_failed',
      },
    });

    const summary = screen.getByText('Tool error').closest('summary');
    expect(summary).not.toBeNull();
    fireEvent.click(summary as HTMLElement);

    expect(screen.getByText(/write_file failed: file_path is missing/)).toBeTruthy();
    expect(screen.queryByText(/tool_use_error/)).toBeNull();
    expect(screen.queryByText(/InputValidationError/)).toBeNull();
  });

  it('keeps permission errors actionable instead of treating them as recoverable tool errors', () => {
    renderToolMessage({
      id: 'tool-2',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'Bash',
      toolId: 'tool-2',
      toolInput: '{"command":"npm test"}',
      toolResult: {
        isError: true,
        content: '<tool_use_error>Permission denied: requires grant</tool_use_error>',
        errorCode: 'permission_required',
      },
    });

    expect(screen.queryByText('Tool error')).toBeNull();
    const summary = screen.getByText('Error').closest('summary');
    expect(summary).not.toBeNull();
    fireEvent.click(summary as HTMLElement);

    expect(screen.getByText(/Grant Bash for this chat/)).toBeTruthy();
    expect(screen.getByText(/Open settings/)).toBeTruthy();
  });
});
