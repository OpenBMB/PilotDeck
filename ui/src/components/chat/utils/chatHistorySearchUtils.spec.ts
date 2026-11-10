// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from 'i18next';
import enCommon from '../../../i18n/locales/en/common.json';
import type { ChatMessage } from '../types/types';
import {
  buildSearchableMessages,
  findChatHistoryMatches,
  highlightSearchMatches,
  scrollSearchTargetIntoView,
} from './chatHistorySearchUtils';

beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { common: enCommon } } });
});

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

  it('highlights every mounted occurrence and distinguishes the active result', () => {
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

    const searchMessage: ChatMessage = {
      id: 'message-1',
      type: 'assistant',
      content: 'needle in the first node needle in the second node',
      timestamp: '2026-05-18T08:00:00.000Z',
    };
    const searchableMessages = buildSearchableMessages([
      {
        message: searchMessage,
        messageKey: 'message:1',
      },
    ]);
    const matches = findChatHistoryMatches(searchableMessages, 'needle');
    const target = highlightSearchMatches(
      container,
      searchableMessages,
      matches,
      'needle',
      matches[1],
    );

    const marks = Array.from(message.querySelectorAll('mark.chat-history-search-highlight'));
    const activeMarks = Array.from(
      message.querySelectorAll('mark.chat-history-search-highlight-active'),
    );

    expect(target).toBe(activeMarks[0]);
    expect(marks).toHaveLength(2);
    expect(activeMarks).toHaveLength(1);
    expect(activeMarks[0].textContent).toBe('needle');
    expect(activeMarks[0].getAttribute('aria-current')).toBe('true');
    expect(marks[0].parentElement).toBe(firstSpan);
    expect(activeMarks[0].parentElement).toBe(secondSpan);
  });

  it('leaves SVG labels and styles intact and falls back to the containing message', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div class="chat-message" data-message-key="diagram"><svg><style>.needle { fill: red }</style><text>needle</text></svg></div>';
    const message = container.firstElementChild;
    const original = message?.innerHTML;
    const searchable = buildSearchableMessages([{ messageKey: 'diagram', message: {
      type: 'assistant', content: '```mermaid\nflowchart LR\n A[needle]\n```',
    } as ChatMessage }]);
    const matches = findChatHistoryMatches(searchable, 'needle');
    const target = highlightSearchMatches(container, searchable, matches, 'needle', matches[0]);
    expect(target).toBe(message);
    expect(message?.innerHTML).toBe(original);
    expect(container.querySelector('mark')).toBeNull();
  });

  it('highlights visible source instead of the hidden diagram fallback', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div class="chat-message" data-message-key="diagram"><div hidden><pre>needle</pre></div><pre>needle</pre></div>';
    const searchable = buildSearchableMessages([{ messageKey: 'diagram', message: {
      type: 'assistant', content: 'needle',
    } as ChatMessage }]);
    const matches = findChatHistoryMatches(searchable, 'needle');
    const target = highlightSearchMatches(container, searchable, matches, 'needle', matches[0]);
    expect(container.querySelector('[hidden] mark')).toBeNull();
    expect(target?.parentElement).toBe(container.querySelector('.chat-message > pre'));
    expect(target?.textContent).toBe('needle');
  });

  it('preserves result order when a diagram and later prose contain the same word', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div class="chat-message" data-message-key="diagram"><div data-chat-search-text="flowchart LR A[needle]"><svg><style>.needle { fill: red }</style><text>needle</text></svg></div><p>needle in the paragraph</p></div>';
    const searchable = buildSearchableMessages([{ messageKey: 'diagram', message: {
      type: 'assistant', content: '```mermaid\nflowchart LR A[needle]\n```\n\nneedle in the paragraph',
    } as ChatMessage }]);
    const matches = findChatHistoryMatches(searchable, 'needle');
    expect(matches).toHaveLength(2);
    const first = highlightSearchMatches(container, searchable, matches, 'needle', matches[0]);
    expect(first).toBe(container.firstElementChild);
    expect(container.querySelector('mark[aria-current]')).toBeNull();
    const second = highlightSearchMatches(container, searchable, matches, 'needle', matches[1]);
    expect(second?.parentElement).toBe(container.querySelector('p'));
    expect(second?.getAttribute('aria-current')).toBe('true');
    expect(container.querySelector('svg mark')).toBeNull();
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
