import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../utils/api';
import { useSessionStore, type NormalizedMessage } from './useSessionStore';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn(), readAgentStatusErrorFromResponse: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const message = (id: string): NormalizedMessage => ({ id, sessionId: 's', provider: 'pilotdeck',
  timestamp: '2026-09-01T00:00:00Z', kind: 'text', role: 'user', content: 'The same prompt' });
const response = (messages: NormalizedMessage[], nextCursor?: string, extra = {}) => ({
  ok: true, json: async () => ({ messages, nextCursor, hasMore: Boolean(nextCursor), total: 300, ...extra }),
} as Response);
const deferred = () => { let resolve!: (response: Response) => void;
  return { promise: new Promise<Response>(done => { resolve = done; }), resolve: (value: Response) => resolve(value) }; };
async function setup() {
  const { result } = renderHook(() => useSessionStore());
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response([message('new')], 'before:new'));
  await act(async () => { await result.current.fetchFromServer('s', { direction: 'backward', limit: 100 }); });
  return result.current;
}

it('coalesces older requests, deduplicates overlapping IDs and preserves identical prompts', async () => {
  const store = await setup();
  const pending = deferred();
  vi.mocked(authenticatedFetch).mockReturnValueOnce(pending.promise);
  let first!: ReturnType<typeof store.fetchMore>, second!: ReturnType<typeof store.fetchMore>;
  act(() => { first = store.fetchMore('s'); second = store.fetchMore('s'); });
  expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  expect(String(vi.mocked(authenticatedFetch).mock.calls[1][0])).toContain('direction=backward&cursor=before%3Anew');
  await act(async () => { pending.resolve(response([message('older'), message('new')])); await Promise.all([first, second]); });
  expect(store.getMessages('s').map(message => message.id)).toEqual(['older', 'new']);
  expect(store.getSessionSlot('s')?.hasMore).toBe(false);
});

it('drops an older page if a newer authoritative refresh replaced its window', async () => {
  const store = await setup();
  const pending = deferred();
  vi.mocked(authenticatedFetch).mockReturnValueOnce(pending.promise);
  const older = store.fetchMore('s');
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response([message('replaced')]));
  await act(async () => { await store.fetchFromServer('s', { direction: 'backward' }); });
  await act(async () => { pending.resolve(response([message('stale')])); await older; });
  expect(store.getMessages('s').map(message => message.id)).toEqual(['replaced']);
});

it('replaces the window after a missing anchor and stops a cursor that makes no progress', async () => {
  const store = await setup();
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response([message('reset')], 'before:reset', { historyReset: true }));
  await act(async () => { await store.fetchMore('s'); });
  expect(store.getMessages('s').map(message => message.id)).toEqual(['reset']);
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response([message('reset')], 'before:reset'));
  await act(async () => { await store.fetchMore('s'); });
  expect(store.getSessionSlot('s')?.hasMore).toBe(false);
  expect(store.getMessages('s').map(message => message.id)).toEqual(['reset']);
});

it('leaves a failed page retryable without losing loaded messages', async () => {
  const store = await setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(authenticatedFetch).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { expect(await store.fetchMore('s')).toBeNull(); });
  expect(store.getSessionSlot('s')?.hasMore).toBe(true);
  expect(store.getMessages('s').map(message => message.id)).toEqual(['new']);
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response([message('retry')]));
  await act(async () => { await store.fetchMore('s'); });
  expect(store.getMessages('s').map(message => message.id)).toEqual(['retry', 'new']);
  vi.restoreAllMocks();
});

it('requests the saved history window when restoring an older reading position', async () => {
  const store = await setup();
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response([message('old'), message('new')], 'before:old'));
  await act(async () => { await store.fetchFromServer('s', { direction: 'backward', limit: 100, includeFromId: 'old' }); });
  expect(String(vi.mocked(authenticatedFetch).mock.calls[1][0])).toContain('includeFromId=old');
  expect(store.getMessages('s').map(message => message.id)).toEqual(['old', 'new']);
  expect(store.getSessionSlot('s')?.historyCursor).toBe('before:old');
});

const turn = (id: string): NormalizedMessage[] => [
  { ...message(`${id}-user`), runId: id, content: `${id} question` },
  { ...message(`${id}-assistant`), runId: id, kind: 'text', role: 'assistant', content: `${id} answer`, isFinal: true,
    timeline: { version: 1, turnId: id, id: 'reply', order: 0, revision: 1 } },
];

it.each(['reenter', 'refresh', 'historyReset'])('replaces the history window without orphaned timeline replies and can reload evicted turns (%s)', async path => {
  const { result } = renderHook(() => useSessionStore());
  const store = result.current;
  const latest = turn('new');
  const earlier = turn('old');
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(latest, 'before:new-user'));
  await act(async () => { await store.fetchFromServer('s', { direction: 'backward', limit: 2 }); });
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(earlier, 'before:old-user'));
  await act(async () => { await store.fetchMore('s'); });
  expect(store.getMessages('s').map(message => message.content)).toEqual(['old question', 'old answer', 'new question', 'new answer']);
  act(() => {
    store.upsertActivity('s', { ...message('old-activity'), runId: 'old', kind: 'agent_activity', state: 'completed' });
    store.applyTimelineMessage('s', { ...earlier[1], content: 'Old child detail', parentRunId: 'old',
      runId: 'old-child-run', isSubagentDetail: true, subagentId: 'old-child',
      timeline: { ...earlier[1].timeline!, turnId: 'old-child-turn' } });
    store.applyTimelineMessage('s', { ...earlier[1], content: 'Old live-only detail',
      timeline: { ...earlier[1].timeline!, id: 'extra', order: 1, revision: 2 } });
  });
  expect(store.getSubagentDetailMessages('s', 'old-child')).toHaveLength(1);
  // Newer live data must survive a paginated HTTP baseline for the same turn.
  act(() => store.applyTimelineMessage('s', { ...latest[1], content: 'newer live answer',
    timeline: { ...latest[1].timeline!, revision: 2 } }));
  act(() => { store.setActiveSession('other'); store.setActiveSession('s'); });
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(latest, 'before:new-user', { historyReset: path === 'historyReset' }));
  await act(async () => {
    if (path === 'refresh') await store.refreshFromServer('s');
    else if (path === 'historyReset') await store.fetchMore('s');
    else await store.fetchFromServer('s', { direction: 'backward', limit: 2 });
  });
  expect(store.getMessages('s').map(message => message.content)).toEqual(['new question', 'newer live answer']);
  expect(store.getSubagentDetailMessages('s', 'old-child')).toHaveLength(0);
  expect(store.getSessionSlot('s')?.activityMessages).toHaveLength(0);
  // Window eviction is not deletion: older pages must restore the entire turn.
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(earlier));
  await act(async () => { await store.fetchMore('s'); });
  expect(store.getMessages('s').map(message => message.content)).toEqual(['old question', 'old answer', 'new question', 'newer live answer']);
});

it('keeps an unconfirmed live turn anchored while replacing a confirmed history window', async () => {
  const { result } = renderHook(() => useSessionStore());
  const store = result.current;
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(turn('old'), 'before:old-user'));
  await act(async () => { await store.fetchFromServer('s', { direction: 'backward', limit: 2 }); });
  act(() => {
    store.appendRealtime('s', turn('live')[0]);
    store.applyTimelineMessage('s', { ...turn('live')[1], isFinal: false, kind: 'stream_delta',
      timeline: { ...turn('live')[1].timeline!, offset: 0 } });
  });
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(response(turn('new'), 'before:new-user'));
  await act(async () => { await store.fetchFromServer('s', { direction: 'backward', limit: 2 }); });
  expect(store.getMessages('s').map(message => message.content)).toEqual(['new question', 'new answer', 'live question', 'live answer']);
});
