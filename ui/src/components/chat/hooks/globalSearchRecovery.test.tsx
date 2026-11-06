import { useCallback, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatHistorySearch } from './useChatHistorySearch';
import ChatHistorySearchBar from '../view/ChatHistorySearchBar';
import type { GlobalSearchTarget } from '../../global-search/GlobalSearchContext';
import type { Project, ProjectSession } from '../../../types/app';
import { getSessionRequestIdentity } from '../utils/sessionRequestIdentity';

const state = vi.hoisted(() => ({ target: null as GlobalSearchTarget | null }));
vi.mock('../../global-search/GlobalSearchContext', () => ({ useGlobalSearch: () => state }));
vi.mock('../../../contexts/FindShortcutContext', () => ({ useRegisterFindShortcutTarget: () => {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }));
const load = vi.fn<() => Promise<void>>();
const messages = [1, 2].map(index => ({ messageKey: `row-${index}`, message: {
  id: `message-${index}`, entryId: `entry-${index}`, type: 'assistant' as const,
  timestamp: '2026-01-01T00:00:00Z', content: `needle response ${index}`,
} }));
let search: ReturnType<typeof useChatHistorySearch>;
function Harness({ sessionId = 'session-a', project, session }: { sessionId?: string; project?: Project; session?: ProjectSession }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const loadAllMessages = useCallback(async () => { await load(); setLoaded(true); }, []);
  search = useChatHistorySearch({ scrollContainerRef: ref, keyedMessages: loaded ? messages : messages.slice(0, 1),
    measuredItemHeights: [100, 100], allMessagesLoaded: loaded, hasMoreMessages: !loaded, loadAllMessages, sessionId,
    requestIdentity: project ? getSessionRequestIdentity(project, session ?? { id: sessionId }) : undefined });
  return <div>{search.isOpen && <ChatHistorySearchBar query={search.query} onQueryChange={search.setQuery}
    matchCount={search.matches.length} activeMatchIndex={search.activeMatchIndex} onPrevious={search.goToPrevious}
    onNext={search.goToNext} onClose={search.closeSearch} inputRef={search.inputRef}
    historyError={search.historyError} isLoadingHistory={search.isLoadingHistory} onRetryHistory={search.retryHistory} />}
    <div ref={ref}>{(loaded ? messages : messages.slice(0, 1)).map(item =>
      <div key={item.messageKey} className="chat-message" data-message-key={item.messageKey}>{item.message.content}</div>)}</div>
  </div>;
}
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  HTMLElement.prototype.scrollTo = vi.fn();
  state.target = { id: 'hit', requestId: 'request-1', kind: 'chats', matchType: 'content', project: { name: 'fixture', displayName: 'Fixture', fullPath: '/fixture' },
    title: 'Chat', sessionId: 'session-a', role: 'assistant', entryId: 'entry-2', query: 'needle' };
});
afterEach(() => { cleanup(); state.target = null; vi.resetAllMocks(); vi.unstubAllGlobals(); });

it('shows full-history failure and retries the same global target without an automatic request loop', async () => {
  load.mockRejectedValueOnce(new Error('History unavailable')).mockResolvedValue(undefined);
  const view = render(<Harness />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not load earlier messages'));
  expect(screen.getByRole('search')).toBeTruthy();
  expect(search.query).toBe('needle');
  view.rerender(<Harness />);
  await act(async () => {});
  expect(load).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(search.activeMatchIndex).toBe(1));
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(search.isOpen).toBe(true);
});

it('does not reopen search or report an old failure after switching sessions', async () => {
  let reject!: (error: Error) => void;
  load.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const view = render(<Harness />);
  expect(load).toHaveBeenCalledTimes(1);
  view.rerender(<Harness sessionId="session-b" />);
  await act(async () => { reject(new Error('Old request failed')); });
  expect(search.isOpen).toBe(false);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

it.each(['project', 'transcript'] as const)('isolates a late failure when %s changes but the session id is reused', async change => {
  let reject!: (error: Error) => void;
  load.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const project = state.target!.project;
  const view = render(<Harness project={project} />);
  expect(load).toHaveBeenCalledTimes(1);
  const nextProject = change === 'project' ? { ...project, name: 'second', fullPath: '/second' } : project;
  const nextSession: ProjectSession = change === 'transcript'
    ? { id: 'session-a', sessionKind: 'background_task', parentSessionId: 'parent', relativeTranscriptPath: 'tasks/second.jsonl' }
    : { id: 'session-a' };
  view.rerender(<Harness project={nextProject} session={nextSession} />);
  await act(async () => { reject(new Error('Previous scope failed')); });
  expect(search.isOpen).toBe(false);
  expect(search.historyError).toBeNull();
  expect(search.isLoadingHistory).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
});
