// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../types/types';
import MessageComponent from './MessageComponent';

const PLAN_MODE_VIOLATION_MESSAGE = '[PLAN_MODE_VIOLATION] Tool "edit_notebook" is BLOCKED in plan mode.\n\nYou are in READ-ONLY plan mode. This tool cannot be executed.';

afterEach(() => {
  cleanup();
  delete window.openSettings;
});

function renderToolMessage(
  message: ChatMessage,
  options: Pick<React.ComponentProps<typeof MessageComponent>, 'onGrantSessionToolPermission'> = {},
) {
  return render(
    <MessageComponent
      message={message}
      prevMessage={null}
      createDiff={() => []}
      provider="pilotdeck"
      onShowSettings={() => {}}
      {...options}
    />,
  );
}

const permissionRequiredMessage: ChatMessage = {
  id: 'tool-permission',
  type: 'assistant',
  content: '',
  timestamp: '2026-05-18T08:00:00.000Z',
  isToolUse: true,
  toolName: 'Bash',
  toolId: 'tool-permission',
  toolInput: '{"command":"npm test"}',
  toolResult: {
    isError: true,
    content: '<tool_use_error>Permission denied: requires grant</tool_use_error>',
    errorCode: 'permission_required',
  },
};

describe('MessageComponent tool errors', () => {
  it('opens the dedicated search settings for web-search setup errors', () => {
    const openSettings = vi.fn();
    window.openSettings = openSettings;
    renderToolMessage({
      id: 'tool-web-search',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'web_search',
      toolId: 'tool-web-search',
      toolInput: '{"query":"PilotDeck"}',
      toolResult: {
        isError: true,
        content: 'Web search requires an API key.',
        errorCode: 'setup_required',
      },
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: /toolUseError\.webSearchNotConfigured\.openSettings|Go to Settings/,
      }),
    );

    expect(openSettings).toHaveBeenCalledWith('config:tools');
  });

  it('renders recoverable write_file errors as neutral collapsed tool details', () => {
    const { container } = renderToolMessage({
      id: 'tool-1',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'write_file',
      toolId: 'tool-1',
      toolInput: '{"file_path":"src/new-page.html","content":"<html></html>"}',
      toolResult: {
        isError: true,
        content: '<tool_use_error>InputValidationError: write_file failed: invalid args</tool_use_error>',
        errorCode: 'tool_execution_failed',
      },
    });

    expect(screen.getAllByText('new-page.html').length).toBeGreaterThan(0);
    expect(screen.queryByText('Parameters')).toBeNull();
    expect(container.querySelector('.border-l-red-500')).toBeNull();

    const summary = screen.getByText('Tool error').closest('summary');
    expect(summary).not.toBeNull();
    expect(summary?.className).not.toContain('text-red');
    const details = summary?.closest('details') as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
    expect(details?.getAttribute('data-auto-expand')).toBe('false');

    fireEvent.click(summary as HTMLElement);

    expect(screen.getByText(/write_file failed: invalid args/)).toBeTruthy();
    expect(screen.queryByText(/tool_use_error/)).toBeNull();
    expect(screen.queryByText(/InputValidationError/)).toBeNull();
  });

  it('keeps permission errors actionable instead of treating them as recoverable tool errors', () => {
    renderToolMessage(permissionRequiredMessage);

    expect(screen.queryByText('Tool error')).toBeNull();
    const summary = screen.getByText('Error').closest('summary');
    expect(summary).not.toBeNull();
    expect(summary?.className).toContain('text-red');
    fireEvent.click(summary as HTMLElement);

    expect(screen.getByRole('button', { name: /permissions\.grant|Grant Bash for this chat/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /permissions\.openSettings|Open settings/ })).toBeTruthy();
  });

  it('waits for session permission grant acknowledgement before showing success', async () => {
    let resolveGrant: ((value: { success: boolean }) => void) | undefined;
    renderToolMessage(permissionRequiredMessage, {
      onGrantSessionToolPermission: () => ({
        success: true,
        pending: true,
        completion: new Promise((resolve) => {
          resolveGrant = resolve;
        }),
      }),
    });

    fireEvent.click(screen.getByText('Error').closest('summary') as HTMLElement);
    const grantButton = screen.getByRole('button', { name: /permissions\.grant|Grant Bash for this chat/ });
    fireEvent.click(grantButton);

    expect(screen.queryByText(/permissions\.added|Added/)).toBeNull();

    resolveGrant?.({ success: false });
    await waitFor(() => {
      expect(screen.getByText(/permissions\.error|Failed to grant permission/)).toBeTruthy();
    });
  });

  it('renders plan-mode tool denials as collapsed tool details without permission actions', () => {
    const { container } = renderToolMessage({
      id: 'tool-3',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'bash',
      toolId: 'tool-3',
      toolInput: '{"command":"cd .","description":"List files"}',
      toolResult: {
        isError: true,
        content: 'Plan mode denies side-effecting tool bash.',
        errorCode: 'permission_denied',
      },
    });

    expect(screen.queryByText('Parameters')).toBeNull();
    expect(container.querySelector('.border-l-red-500')).toBeNull();
    expect(screen.queryByRole('button', { name: /permissions\.grant|Grant Bash for this chat/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /permissions\.openSettings|Open settings/ })).toBeNull();

    const summary = screen.getByText('Tool error').closest('summary');
    expect(summary).not.toBeNull();
    const details = summary?.closest('details') as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);

    fireEvent.click(summary as HTMLElement);
    expect(screen.getByText(/Plan mode denies side-effecting tool bash/)).toBeTruthy();
  });

  it('renders structured plan-mode violations as collapsed tool details without permission actions', () => {
    const { container } = renderToolMessage({
      id: 'tool-4',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'edit_notebook',
      toolId: 'tool-4',
      toolInput: '{"file_path":"notebook.ipynb"}',
      toolResult: {
        isError: true,
        content: PLAN_MODE_VIOLATION_MESSAGE,
        errorCode: 'plan_mode_violation',
      },
    });

    expect(container.querySelector('.border-l-red-500')).toBeNull();
    expect(screen.queryByRole('button', { name: /permissions\.grant|Grant edit_notebook for this chat/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /permissions\.openSettings|Open settings/ })).toBeNull();

    const summary = screen.getByText('Tool error').closest('summary');
    expect(summary).not.toBeNull();
    const details = summary?.closest('details') as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);

    fireEvent.click(summary as HTMLElement);
    expect(screen.getByText(/\[PLAN_MODE_VIOLATION\]/)).toBeTruthy();
  });
});
