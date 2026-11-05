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
