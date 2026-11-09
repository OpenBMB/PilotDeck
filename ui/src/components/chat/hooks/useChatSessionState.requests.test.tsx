import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../utils/api';
import { useSessionStore } from '../../../stores/useSessionStore';
import { useChatSessionState } from './useChatSessionState';
import type { Project, ProjectSession } from '../../../types/app';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn(), readAgentStatusErrorFromResponse: vi.fn(async () => ({ message: 'History temporarily unavailable' })) }));
vi.mock('../tools/useVideoJobs', () => ({ useVideoJobs: (messages: unknown) => messages }));
vi.mock('./useScrollFollow', () => {
  const noop = () => {};
  const scroll = { isPaused: false, canReturnToLatest: false, setPaused: noop, getIsPaused: () => false, pauseAt: noop,
    scrollToBottom: noop, scheduleFollow: noop, scheduleInitialPosition: noop, captureAnchor: () => null,
    getReadingAnchor: () => null, restoreReadingAnchor: noop };
  return { useScrollFollow: () => scroll };
});

const project: Project = { name: 'fixture', fullPath: '/fixture', displayName: 'Fixture' };
const sessionA: ProjectSession = { id: 'session-a', title: 'A' };
const sessionB: ProjectSession = { id: 'session-b', title: 'B' };
const noop = () => {};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const history = (hasMore = false, total = 0) => json({ messages: [], total, hasMore });
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
};
const urls = (part: string) => vi.mocked(authenticatedFetch).mock.calls.map(([url]) => String(url)).filter(url => url.includes(part));
type Props = { project: Project | null; session: ProjectSession | null; externalMessageUpdate?: number;
  externalMessageUpdateTarget?: { projectName: string; sessionId: string; relativeTranscriptPath?: string } | null };
const initial: Props = { project, session: sessionA, externalMessageUpdate: 0 };
function mount(strict = false, initialProps = initial) {
  const pendingViewSessionRef = { current: null };
  return renderHook(({ project: selectedProject, session: selectedSession, ...updates }: Props) => {
    const store = useSessionStore();
    const view = useChatSessionState({ selectedProject, selectedSession, sessionStore: store, ...updates,
      ws: null, sendMessage: noop, autoScrollToBottom: false, resetStreamingState: noop, pendingViewSessionRef });
    return { store, view };
  }, { initialProps, ...(strict ? { wrapper: StrictMode } : {}) });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.mocked(authenticatedFetch).mockImplementation(async url => String(url).includes('/token-usage') ? json({ used: 20 }) : history());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('keeps B budget when an older A response finishes after selection changed', async () => {
  const old = deferred();
  vi.mocked(authenticatedFetch).mockImplementation(async url => String(url).includes('/session-a/token-usage') ? old.promise
    : String(url).includes('/token-usage') ? json({ used: 200 }) : history());
  const { result, rerender } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  rerender({ ...initial, session: sessionB });
  await waitFor(() => expect(result.current.view.tokenBudget).toEqual({ used: 200 }));
  await act(async () => { old.resolve(json({ used: 100 })); await old.promise; });
  expect(result.current.view.tokenBudget).toEqual({ used: 200 });
});

it('does not accept a previous A budget after an A to B to A revisit', async () => {
  const old = deferred();
  let aRequests = 0;
  vi.mocked(authenticatedFetch).mockImplementation(async url => {
    if (String(url).includes('/session-a/token-usage')) return ++aRequests === 1 ? old.promise : json({ used: 300 });
    return String(url).includes('/token-usage') ? json({ used: 200 }) : history();
  });
  const { result, rerender } = mount();
  await waitFor(() => expect(aRequests).toBe(1));
  rerender({ ...initial, session: sessionB });
  await waitFor(() => expect(result.current.view.tokenBudget).toEqual({ used: 200 }));
  rerender(initial);
  await waitFor(() => expect(result.current.view.tokenBudget).toEqual({ used: 300 }));
  await act(async () => { old.resolve(json({ used: 100 })); await old.promise; });
  expect(result.current.view.tokenBudget).toEqual({ used: 300 });
});

it('preserves a newer realtime budget over the initial HTTP snapshot', async () => {
  const old = deferred();
  vi.mocked(authenticatedFetch).mockImplementation(async url => String(url).includes('/token-usage') ? old.promise : history());
  const { result } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  act(() => result.current.view.setTokenBudget({ used: 900 }));
  await act(async () => { old.resolve(json({ used: 100 })); await old.promise; });
  expect(result.current.view.tokenBudget).toEqual({ used: 900 });
});

it('does not refetch budget when project and session objects are refreshed without a scope change', async () => {
  const { result, rerender } = mount();
  await waitFor(() => expect(result.current.view.tokenBudget).toEqual({ used: 20 }));
  rerender({ ...initial, project: { ...project }, session: { ...sessionA } });
  await act(async () => {});
  expect(urls('/token-usage')).toHaveLength(1);
});

it('does not interpret an omitted external revision as a new update', async () => {
  const props = { ...initial, externalMessageUpdate: undefined };
  const { result, rerender } = mount(false, props);
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  rerender({ ...props, project: { ...project } });
  await act(async () => {});
  expect(urls('/session-a/messages')).toHaveLength(1);
});

it.each([true, false])('prefers dedicated token usage over a history estimate (history first: %s)', async historyFirst => {
  const historyResponse = deferred();
  const budgetResponse = deferred();
  vi.mocked(authenticatedFetch).mockImplementation(async url => String(url).includes('/token-usage') ? budgetResponse.promise : historyResponse.promise);
  const { result } = mount();
  const resolveHistory = async () => { historyResponse.resolve(json({ messages: [], total: 0, hasMore: false, tokenUsage: { used: 100 } })); await historyResponse.promise; };
  const resolveBudget = async () => { budgetResponse.resolve(json({ used: 200 })); await budgetResponse.promise; };
  await act(historyFirst ? resolveHistory : resolveBudget);
  await act(historyFirst ? resolveBudget : resolveHistory);
  await waitFor(() => expect(result.current.view.tokenBudget).toEqual({ used: 200 }));
});

it('keeps the latest initial load pending when a previous visit finishes after A to B to A', async () => {
  const old = deferred();
  const latest = deferred();
  let aRequests = 0;
  vi.mocked(authenticatedFetch).mockImplementation(async url => {
    if (String(url).includes('/session-a/messages')) return ++aRequests === 1 ? old.promise : latest.promise;
    return String(url).includes('/token-usage') ? json({ used: 20 }) : history();
  });
  const { result, rerender } = mount();
  await waitFor(() => expect(aRequests).toBe(1));
  rerender({ ...initial, session: sessionB });
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  rerender(initial);
  await waitFor(() => expect(aRequests).toBe(2));
  await act(async () => { old.resolve(history(true, 100)); await old.promise; });
  expect(result.current.view.isLoadingSessionMessages).toBe(true);
  await act(async () => { latest.resolve(history(false, 2)); await latest.promise; });
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  expect(result.current.view.totalMessages).toBe(2);
});

it('does not replay a consumed external update into an unbounded duplicate load for B', async () => {
  const { result, rerender } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  rerender({ ...initial, externalMessageUpdate: 1 });
  await waitFor(() => expect(urls('/session-a/messages')).toHaveLength(2));
  rerender({ ...initial, session: sessionB, externalMessageUpdate: 1 });
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  expect(urls('/session-b/messages')).toHaveLength(1);
  expect(urls('/session-b/messages')[0]).toContain('limit=100');
});

it('does not assign an A notification to B when selection and notification arrive in the same batch', async () => {
  const { result, rerender } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  rerender({ ...initial, session: sessionB, externalMessageUpdate: 1,
    externalMessageUpdateTarget: { projectName: project.name, sessionId: sessionA.id } });
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  expect(urls('/session-b/messages')).toHaveLength(1);
});

it('defers a revision during streaming and consumes it once after streaming ends', async () => {
  const { result, rerender } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  act(() => result.current.view.setIsLoading(true));
  rerender({ ...initial, externalMessageUpdate: 1 });
  expect(urls('/session-a/messages')).toHaveLength(1);
  act(() => result.current.view.setIsLoading(false));
  await waitFor(() => expect(urls('/session-a/messages')).toHaveLength(2));
  rerender({ ...initial, externalMessageUpdate: 1, project: { ...project }, session: { ...sessionA } });
  await act(async () => {});
  expect(urls('/session-a/messages')).toHaveLength(2);
});

it.each([false, true])('clears initial failure after retry recovers history (nonempty: %s)', async nonempty => {
  let requests = 0;
  vi.mocked(authenticatedFetch).mockImplementation(async url => {
    if (String(url).includes('/token-usage')) return json({ used: 20 });
    return ++requests === 1 ? json({}, 503) : json({ messages: nonempty ? [{ id: 'persisted', kind: 'text', role: 'assistant', content: 'Recovered', timestamp: '2026-01-01T00:00:00Z' }] : [], total: nonempty ? 1 : 0, hasMore: false });
  });
  const { result } = mount();
  await waitFor(() => expect(result.current.view.sessionLoadError).toBeTruthy());
  await act(async () => { await result.current.view.retrySessionMessages(); });
  expect(result.current.view.sessionLoadError).toBeNull();
  expect(result.current.view.isLoadingSessionMessages).toBe(false);
  expect(result.current.view.chatMessages).toHaveLength(nonempty ? 1 : 0);
  expect(result.current.view.totalMessages).toBe(nonempty ? 1 : 0);
  expect(result.current.view.hasMoreMessages).toBe(false);
});

it('reports full-history failure and can retry without marking incomplete history loaded', async () => {
  let requests = 0;
  vi.mocked(authenticatedFetch).mockImplementation(async url => {
    if (String(url).includes('/token-usage')) return json({ used: 20 });
    return ++requests === 1 ? history(true, 200) : requests === 2 ? json({}, 503) : history(false, 200);
  });
  const { result } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  await act(async () => { await expect(result.current.view.loadAllMessages()).rejects.toThrow('History temporarily unavailable'); });
  expect(result.current.view.historyLoadError).toBe(true);
  expect(result.current.view.allMessagesLoaded).toBe(false);
  await act(async () => { await result.current.view.loadAllMessages(); });
  expect(result.current.view.historyLoadError).toBe(false);
  expect(result.current.view.allMessagesLoaded).toBe(true);
});

it('coalesces simultaneous full-history consumers and settles both with the same outcome', async () => {
  const full = deferred();
  vi.mocked(authenticatedFetch).mockImplementation(async url => String(url).includes('/token-usage') ? json({ used: 20 })
    : String(url).includes('limit=100') ? history(true, 200) : full.promise);
  const { result } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  let requests!: Promise<void>[];
  act(() => { requests = [result.current.view.loadAllMessages(), result.current.view.loadAllMessages()]; });
  await waitFor(() => expect(urls('/session-a/messages')).toHaveLength(2));
  await act(async () => { full.resolve(history(false, 200)); await Promise.all(requests); });
  expect(result.current.view.allMessagesLoaded).toBe(true);
  expect(result.current.view.isLoadingAllMessages).toBe(false);
});

it('makes a full-history request superseded by a partial refresh retryable', async () => {
  const full = deferred();
  let messageRequests = 0;
  vi.mocked(authenticatedFetch).mockImplementation(async url => {
    if (String(url).includes('/token-usage')) return json({ used: 20 });
    messageRequests += 1;
    if (messageRequests === 2) return full.promise;
    if (messageRequests === 3) return json({ messages: [{ id: 'persisted', kind: 'text', role: 'assistant',
      content: 'Latest reply', timestamp: '2026-01-01T00:00:00Z' }], hasMore: true, total: 200 });
    return history(messageRequests < 4, 200);
  });
  const { result } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  let request!: Promise<void>;
  act(() => { request = result.current.view.loadAllMessages(); });
  await waitFor(() => expect(messageRequests).toBe(2));
  await act(async () => { expect((await result.current.view.refreshSessionMessages()).status).toBe('success'); });
  expect(result.current.view.hasMoreMessages).toBe(true);
  await act(async () => {
    full.resolve(history(false, 200));
    await expect(request).rejects.toThrow('Conversation changed while loading history');
  });
  expect(result.current.view.historyLoadError).toBe(true);
  expect(result.current.view.allMessagesLoaded).toBe(false);
  expect(result.current.view.isLoadingAllMessages).toBe(false);
  await act(async () => { await result.current.view.loadAllMessages(); });
  expect(result.current.view.historyLoadError).toBe(false);
  expect(result.current.view.allMessagesLoaded).toBe(true);
});

it('does not report a superseded full-history request as an error in a different session', async () => {
  const full = deferred();
  vi.mocked(authenticatedFetch).mockImplementation(async url => String(url).includes('/token-usage') ? json({ used: 20 })
    : String(url).includes('/session-a/messages') && !String(url).includes('limit=100') ? full.promise : history(true, 200));
  const { result, rerender } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  let request!: Promise<void>;
  act(() => { request = result.current.view.loadAllMessages(); });
  await waitFor(() => expect(urls('/session-a/messages')).toHaveLength(2));
  rerender({ ...initial, session: sessionB });
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  await act(async () => { full.resolve(history(false, 200)); await request; });
  expect(result.current.view.historyLoadError).toBe(false);
  expect(result.current.view.allMessagesLoaded).toBe(false);
});

it('clears loading state on welcome while the previous history request is still pending', async () => {
  const old = deferred();
  vi.mocked(authenticatedFetch).mockImplementation(async url => String(url).includes('/token-usage') ? json({ used: 20 }) : old.promise);
  const { result, rerender } = mount();
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(true));
  rerender({ ...initial, session: null });
  expect(result.current.view.isLoadingSessionMessages).toBe(false);
  await act(async () => { old.resolve(history()); await old.promise; });
  expect(result.current.view.currentSessionId).toBeNull();
});

it('loads history after StrictMode effect replay', async () => {
  const { result } = mount(true);
  await waitFor(() => expect(result.current.view.isLoadingSessionMessages).toBe(false));
  expect(result.current.view.sessionLoadError).toBeNull();
  expect(result.current.view.tokenBudget).toEqual({ used: 20 });
});
