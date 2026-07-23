// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import {
  buildSearchableMessages,
  findChatHistoryMatches,
  highlightActiveMatch,
  scrollSearchTargetIntoView,
} from './chatHistorySearchUtils';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('chatHistorySearchUtils', () => {
  it('does not index successful tool results that the UI hides', () => {
    const readMessage: ChatMessage = {
      id: 'read-1',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'Read',
      toolId: 'read-1',
      toolInput: '{"file_path":"src/App.tsx"}',
      toolResult: { content: 'hidden-file-content-needle', isError: false },
    };

    const searchableMessages = buildSearchableMessages([
      { message: readMessage, messageKey: 'm1' },
    ]);

    expect(findChatHistoryMatches(searchableMessages, 'hidden-file-content-needle')).toHaveLength(0);
    expect(findChatHistoryMatches(searchableMessages, 'src/App.tsx')).toHaveLength(0);
    expect(findChatHistoryMatches(searchableMessages, 'App.tsx')).toHaveLength(1);
  });

  it('does not index collapsed tool input or result bodies', () => {
    const writeMessage: ChatMessage = {
      id: 'write-1',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'write_file',
      toolId: 'write-1',
      toolInput: JSON.stringify({
        file_path: 'src/NewWidget.tsx',
        content: 'hidden-write-body-needle',
      }),
      toolResult: { content: 'File written successfully', isError: false },
    };
    const bashMessage: ChatMessage = {
      id: 'bash-1',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:01.000Z',
      isToolUse: true,
      toolName: 'Bash',
      toolId: 'bash-1',
      toolInput: JSON.stringify({ command: 'echo visible-command-needle' }),
      toolResult: { content: 'hidden-output-needle', isError: false },
    };

    const searchableMessages = buildSearchableMessages([
      { message: writeMessage, messageKey: 'write-1' },
      { message: bashMessage, messageKey: 'bash-1' },
    ]);

    expect(findChatHistoryMatches(searchableMessages, 'hidden-write-body-needle')).toHaveLength(0);
    expect(findChatHistoryMatches(searchableMessages, 'hidden-output-needle')).toHaveLength(0);
    expect(findChatHistoryMatches(searchableMessages, 'NewWidget.tsx')).toHaveLength(1);
    expect(findChatHistoryMatches(searchableMessages, 'visible-command-needle')).toHaveLength(1);
    expect(findChatHistoryMatches(searchableMessages, 'Output')).toHaveLength(1);
  });

  it('keeps visible tool error text searchable', () => {
    const errorMessage: ChatMessage = {
      id: 'edit-error-1',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'edit_file',
      toolId: 'edit-error-1',
      toolInput: JSON.stringify({
        file_path: 'src/App.tsx',
        old_string: 'hidden-old-needle',
        new_string: 'hidden-new-needle',
      }),
      toolResult: {
        content: 'visible-error-needle: old_string was not found',
        isError: true,
      },
    };

    const searchableMessages = buildSearchableMessages([
      { message: errorMessage, messageKey: 'edit-error-1' },
    ]);

    expect(findChatHistoryMatches(searchableMessages, 'hidden-old-needle')).toHaveLength(0);
    expect(findChatHistoryMatches(searchableMessages, 'visible-error-needle')).toHaveLength(1);
  });

  it('indexes visible subagent card summaries without hidden detail content', () => {
    const thinkingMessage: ChatMessage = {
      id: 'thinking-1',
      type: 'assistant',
      content: 'hidden thinking needle',
      timestamp: '2026-05-18T08:00:00.000Z',
      isThinking: true,
    };
    const subagentMessage: ChatMessage = {
      id: 'subagent-1',
      type: 'assistant',
      content: 'hidden subagent needle',
      timestamp: '2026-05-18T08:00:01.000Z',
      isSubagentContainer: true,
      toolInput: JSON.stringify({
        subagent_type: 'reviewer',
        description: 'Audit checkout flow',
        prompt: 'hidden subagent prompt needle',
      }),
    };

    const searchableMessages = buildSearchableMessages([
      { message: thinkingMessage, messageKey: 'thinking-1' },
      { message: subagentMessage, messageKey: 'subagent-1' },
    ]);

    expect(findChatHistoryMatches(searchableMessages, 'hidden thinking needle')).toHaveLength(0);
    expect(findChatHistoryMatches(searchableMessages, 'hidden subagent needle')).toHaveLength(0);
    expect(findChatHistoryMatches(searchableMessages, 'hidden subagent prompt needle')).toHaveLength(0);
    expect(findChatHistoryMatches(searchableMessages, 'reviewer')).toHaveLength(1);
    expect(findChatHistoryMatches(searchableMessages, 'Audit checkout flow')).toHaveLength(1);
  });

  it('highlights the active occurrence when earlier matches are in previous text nodes', () => {
    const container = document.createElement('div');
    const message = document.createElement('div');
    const firstSpan = document.createElement('span');
    const secondSpan = document.createElement('span');

    message.className = 'chat-message';
    message.dataset.messageKey = 'message:1';
    firstSpan.textContent = 'needle in the first node ';
    secondSpan.textContent = 'needle in the second node';
    message.append(firstSpan, secondSpan);
    container.append(message);
    document.body.append(container);

    const target = highlightActiveMatch(
      container,
      'message:1',
      'needle in the first node needle in the second node',
      'needle',
      'needle in the first node '.length,
    );

    const marks = Array.from(message.querySelectorAll('mark.chat-history-search-highlight-active'));

    expect(target).toBe(marks[0]);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('needle');
    expect(marks[0].parentElement).toBe(secondSpan);
    expect(firstSpan.querySelector('mark')).toBeNull();
  });

  it('centers a mounted result relative to the current conversation scroll position', () => {
    const container = document.createElement('div');
    const target = document.createElement('mark');
    const scrollTo = vi.fn();

    container.scrollTop = 400;
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 });
    container.scrollTo = scrollTo;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 400,
      left: 0,
      right: 500,
      width: 500,
      height: 300,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 250,
      bottom: 270,
      left: 0,
      right: 80,
      width: 80,
      height: 20,
      x: 0,
      y: 250,
      toJSON: () => ({}),
    });

    scrollSearchTargetIntoView(container, target);

    expect(scrollTo).toHaveBeenCalledWith({ top: 410, behavior: 'smooth' });
  });

});
