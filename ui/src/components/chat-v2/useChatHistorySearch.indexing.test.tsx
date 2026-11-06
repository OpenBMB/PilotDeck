import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatHistorySearch } from './useChatHistorySearch';
import type { SearchableChatMessageInput } from './chatHistorySearchUtils';

vi.mock('../../contexts/FindShortcutContext', () => ({ useRegisterFindShortcutTarget: () => {} }));
vi.mock('../global-search/GlobalSearchContext', () => ({ useGlobalSearch: () => null }));
afterEach(cleanup);

it('does not read message bodies for closed search, but indexes current and streaming text when opened', () => {
  let reads = 0;
  const message = (id: string, content: string): SearchableChatMessageInput => ({
    messageKey: id,
    message: { id, type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
      get content() { reads++; return content; } },
  });
  const first = message('first', 'needle');
  const second = message('second', 'another needle');
  const scrollContainerRef = { current: null };
  const { result, rerender } = renderHook(({ messages }) => useChatHistorySearch({
    scrollContainerRef, keyedMessages: messages, measuredItemHeights: [],
    allMessagesLoaded: true, hasMoreMessages: false, loadAllMessages: () => {}, sessionId: 'fixture',
  }), { initialProps: { messages: [first] } });
  expect(reads).toBe(0);
  rerender({ messages: [first, second] });
  expect(reads).toBe(0);
  act(() => { result.current.openSearch(); result.current.setQuery('needle'); });
  expect(result.current.matches.map(match => match.messageKey)).toEqual(['first', 'second']);
  const updated = message('second', 'two needle hits: needle');
  rerender({ messages: [first, updated] });
  expect(result.current.matches).toHaveLength(3);
  act(() => result.current.closeSearch());
  reads = 0;
  rerender({ messages: [first, message('second', 'new streamed content')] });
  expect(reads).toBe(0);
  expect(result.current.matches).toEqual([]);
});
