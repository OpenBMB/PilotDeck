// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import type { ChatMessage } from '../../types/types';
import { createTestI18n } from '../../../../i18n/testInstance';
import MessageComponent from './MessageComponent';

afterEach(() => {
  cleanup();
});

async function renderToolMessage(message: ChatMessage, language = 'en') {
  const i18n = await createTestI18n(language);
  return render(
    <I18nextProvider i18n={i18n}><MessageComponent
      message={message}
      prevMessage={null}
      createDiff={() => []}
      provider="pilotdeck"
      onShowSettings={() => {}}
    /></I18nextProvider>,
  );
}

describe('MessageComponent todo_write rendering', () => {
  it('renders markdown checklist details for lowercase todo_write tool calls', async () => {
    await renderToolMessage({
      id: 'todo-tool-1',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'todo_write',
      toolId: 'todo-tool-1',
      toolInput: {
        markdown: ['- [x] Create project directory structure', '- [ ] Implement game constants'].join('\n'),
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Updating todo list 1/2 completed' }));

    expect(screen.getByText('Create project directory structure')).toBeTruthy();
    expect(screen.getByText('Implement game constants')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
  });

  it.each(['en', 'zh-CN'])('renders one localized TodoWrite acknowledgement with a retained checklist (%s)', async language => {
    await renderToolMessage({
      id: 'todo-tool-2',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'TodoWrite',
      toolId: 'todo-tool-2',
      toolInput: {
        markdown: '- [ ] Create project directory structure',
      },
      toolResult: {
        isError: false,
        content: 'Todo list updated',
      },
    }, language);

    const header = screen.getByRole('button', { name: language === 'en' ? 'Todo list 0/1 completed' : '待办事项 已完成 0/1' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('TodoWrite')).toBeNull();
    expect(screen.queryByText('Details')).toBeNull();
    expect(screen.queryByText('Todo list updated')).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText('Create project directory structure')).toBeTruthy();
    fireEvent.click(header);
    expect(screen.getByText('Create project directory structure').closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('accepts structured todo items and keeps failures visible', async () => {
    await renderToolMessage({ id: 'structured-todo', type: 'assistant', content: '', timestamp: '2026-01-01T00:00:00Z', isToolUse: true, toolName: 'TodoWrite',
      toolInput: { todos: [{ content: 'Verify changes', status: 'completed' }, { content: 'Publish changes', status: 'pending' }] },
      toolResult: { isError: true, content: 'Unable to save checklist' } });
    fireEvent.click(screen.getByRole('button', { name: 'Updating todo list 1/2 completed' }));
    expect(screen.getByText('Verify changes')).toBeTruthy();
    expect(screen.getByText('Publish changes')).toBeTruthy();
    expect(screen.getByText('Unable to save checklist')).toBeTruthy();
  });
});
