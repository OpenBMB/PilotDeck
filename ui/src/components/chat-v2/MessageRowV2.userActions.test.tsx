// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import MessageRowV2 from './MessageRowV2';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

afterEach(cleanup);

function renderUserMessage(
  message: ChatMessage,
  options: {
    canEdit?: boolean;
    onRegenerate?: (message: ChatMessage, text: string) => Promise<void>;
    onFork?: (message: ChatMessage, carried: number) => void;
  } = {},
) {
  return render(
    <MessageRowV2
      message={message}
      prevMessage={null}
      provider="pilotdeck"
      selectedProject={null}
      createDiff={() => []}
      canEdit={options.canEdit}
      onRegenerate={options.onRegenerate}
      onFork={options.onFork}
    />,
  );
}

describe('MessageRowV2 user actions', () => {
  it('keeps the action row hidden until hover or focus and orders time, copy, edit, then branch', () => {
    const message: ChatMessage = {
      id: 'user-1',
      entryId: 'entry-1',
      turnId: 'turn-1',
      type: 'user',
      content: 'Original request',
      timestamp: '2026-08-25T12:00:00.000Z',
    };
    const onRegenerate = vi.fn(async () => undefined);
    const { rerender } = renderUserMessage(message, {
      canEdit: true,
      onRegenerate,
      onFork: vi.fn(),
    });

    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Fork from here/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeTruthy();
    const actionRow = screen.getByTestId('user-message-actions');
    expect(actionRow.className).toContain('pointer-events-none');
    expect(actionRow.className).toContain('opacity-0');
    expect(actionRow.className).toContain('group-hover/user-msg:pointer-events-auto');
    expect(actionRow.className).toContain('group-hover/user-msg:opacity-100');
    expect(actionRow.className).toContain('group-focus-within/user-msg:opacity-100');
    expect(actionRow.querySelector('time')?.getAttribute('datetime')).toBe(message.timestamp);
    expect(Array.from(actionRow.querySelectorAll('button')).map((button) => button.getAttribute('aria-label')))
      .toEqual([
        'Copy message',
        'Edit message',
        'Fork from here · carries 0 messages',
      ]);

    rerender(
      <MessageRowV2
        message={message}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
        canEdit={false}
        onRegenerate={onRegenerate}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
  });

  it('edits only the text while preserving the original message payload for regeneration', async () => {
    const message: ChatMessage = {
      id: 'user-with-file',
      entryId: 'entry-with-file',
      turnId: 'turn-with-file',
      type: 'user',
      content: 'Typo in requset',
      timestamp: '2026-08-25T12:00:00.000Z',
      attachments: [{ name: 'brief.pdf', path: '/workspace/brief.pdf' }],
    };
    const onRegenerate = vi.fn(async () => undefined);
    renderUserMessage(message, { canEdit: true, onRegenerate });

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message' });
    expect((editor as HTMLTextAreaElement).value).toBe('Typo in requset');
    fireEvent.change(editor, { target: { value: 'Typo in request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onRegenerate).toHaveBeenCalledWith(message, 'Typo in request'));
  });

  it('submits with Enter, keeps Shift+Enter for a newline, and ignores IME confirmation Enter', async () => {
    const message: ChatMessage = {
      id: 'user-keyboard-edit',
      entryId: 'entry-keyboard-edit',
      turnId: 'turn-keyboard-edit',
      type: 'user',
      content: 'First line',
      timestamp: '2026-08-25T12:00:00.000Z',
    };
    const onRegenerate = vi.fn(async () => undefined);
    renderUserMessage(message, { canEdit: true, onRegenerate });

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message' });

    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(onRegenerate).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: 'First line\nSecond line' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(onRegenerate).toHaveBeenCalledWith(message, 'First line\nSecond line'));
  });
});

describe('MessageRowV2 assistant actions', () => {
  it('keeps time, copy, and branch hidden at the bottom left until the response is hovered or focused', () => {
    const message: ChatMessage = {
      id: 'assistant-1',
      entryId: 'assistant-entry-1',
      turnId: 'turn-1',
      type: 'assistant',
      content: 'Generated response',
      timestamp: '2026-08-25T12:00:01.000Z',
    };

    render(
      <MessageRowV2
        message={message}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
        onFork={vi.fn()}
      />,
    );

    const actionRow = screen.getByTestId('assistant-message-actions');
    expect(actionRow.className).toContain('justify-start');
    expect(actionRow.className).toContain('pointer-events-none');
    expect(actionRow.className).toContain('opacity-0');
    expect(actionRow.className).toContain('group-hover/assistant-msg:pointer-events-auto');
    expect(actionRow.className).toContain('group-hover/assistant-msg:opacity-100');
    expect(actionRow.className).toContain('group-focus-within/assistant-msg:opacity-100');
    expect(actionRow.querySelector('time')?.getAttribute('datetime')).toBe(message.timestamp);
    expect(Array.from(actionRow.children).map((element) => element.tagName.toLowerCase()))
      .toEqual(['time', 'button', 'button']);
    expect(Array.from(actionRow.querySelectorAll('button')).map((button) => button.getAttribute('aria-label')))
      .toEqual([
        'Copy message',
        'Fork from here · carries 0 messages',
      ]);
  });
});
