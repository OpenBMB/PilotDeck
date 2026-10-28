// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatHistorySearch } from './useChatHistorySearch';
import type { SearchableChatMessageInput } from './chatHistorySearchUtils';
import type { GlobalSearchTarget } from '../global-search/GlobalSearchContext';

const state = vi.hoisted(() => ({ target: null as GlobalSearchTarget | null }));
vi.mock('../global-search/GlobalSearchContext', () => ({ useGlobalSearch: () => state }));
vi.mock('../../contexts/FindShortcutContext', () => ({ useRegisterFindShortcutTarget: () => {} }));
let search: ReturnType<typeof useChatHistorySearch>;
const messages: SearchableChatMessageInput[] = [1, 2].map(index => ({
  messageKey: `row-${index}`, message: { id: `message-${index}`, entryId: `entry-${index}`,
    type: 'assistant', timestamp: '2026-10-27T08:00:00Z', content: `needle response ${index}` },
}));
const heights = [100, 100];
const load = vi.fn();
function Harness({ loaded = true, serverHasMore = !loaded, ready = true }: { loaded?: boolean; serverHasMore?: boolean; ready?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  search = useChatHistorySearch({ scrollContainerRef: container,
    keyedMessages: loaded ? messages : messages.slice(0, 1), measuredItemHeights: heights,
    allMessagesLoaded: loaded, hasMoreMessages: serverHasMore, historyReady: ready, loadAllMessages: load, sessionId: 'old-session' });
  return <div ref={container}>{(loaded ? messages : messages.slice(0, 1)).map(item =>
    <div key={item.messageKey} className="chat-message" data-message-key={item.messageKey}>{item.message.content}</div>)}</div>;
}
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  HTMLElement.prototype.scrollTo = vi.fn();
  state.target = { id: 'hit', requestId: 'request-1', kind: 'chats', matchType: 'content', project: { name: 'example', displayName: 'Example', fullPath: '/workspace' },
    title: 'Old chat', sessionId: 'old-session', role: 'assistant', entryId: 'entry-2', query: 'needle' };
});
afterEach(() => { cleanup(); state.target = null; vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('loads old history before revealing the requested message when multiple messages match', async () => {
  const view = render(<Harness loaded={false} />);
  expect(load).toHaveBeenCalledTimes(1);
  expect(search.isOpen).toBe(false);
  view.rerender(<Harness />);
  await waitFor(() => expect(search.isOpen).toBe(true));
  expect(search.query).toBe('needle');
  expect(search.activeMatchIndex).toBe(1);
  await waitFor(() => expect(view.container.querySelector('mark[aria-current="true"]')?.closest('[data-message-key]')?.getAttribute('data-message-key')).toBe('row-2'));
  expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
});

it('can reveal another matching message in the same session without changing the query', async () => {
  const view = render(<Harness />);
  await waitFor(() => expect(search.activeMatchIndex).toBe(1));
  state.target = { ...state.target!, requestId: 'request-2', entryId: 'entry-1' };
  act(() => view.rerender(<Harness />));
  await waitFor(() => expect(search.activeMatchIndex).toBe(0));
  expect(search.query).toBe('needle');
});

it('opens title-only chat results without loading all history or highlighting the preview', () => {
  state.target = { ...state.target!, matchType: 'title', entryId: undefined };
  render(<Harness loaded={false} />);
  expect(load).not.toHaveBeenCalled();
  expect(search.isOpen).toBe(false);
  expect(search.query).toBe('');
});

it('reveals messages beyond the recent render window even when the server has no more pages', async () => {
  const view = render(<Harness loaded={false} serverHasMore={false} />);
  expect(load).toHaveBeenCalledTimes(1);
  view.rerender(<Harness />);
  await waitFor(() => expect(search.activeMatchIndex).toBe(1));
  expect(search.query).toBe('needle');
});

it('waits for the initial session history before requesting full history', () => {
  const view = render(<Harness loaded={false} serverHasMore={false} ready={false} />);
  expect(load).not.toHaveBeenCalled();
  view.rerender(<Harness loaded={false} serverHasMore={false} />);
  expect(load).toHaveBeenCalledTimes(1);
});
