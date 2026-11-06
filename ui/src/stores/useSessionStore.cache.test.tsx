import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSessionStore, type NormalizedMessage, type SessionStore } from './useSessionStore';
import { authenticatedFetch } from '../utils/api';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn(), readAgentStatusErrorFromResponse: vi.fn() }));
const history = (sessionId: string): NormalizedMessage => ({
  id: `history-${sessionId}`, sessionId, timestamp: '2026-01-01T00:00:00Z',
  provider: 'pilotdeck', kind: 'text', role: 'assistant', content: `saved ${sessionId}`,
});
const response = (sessionId: string) => new Response(JSON.stringify({ messages: [history(sessionId)], total: 1, hasMore: false }));
async function browse(store: SessionStore, sessionId: string) {
  await act(async () => {
    store.setActiveSession(sessionId);
    await store.fetchFromServer(sessionId);
    // Every normal visit also receives an idle session-status response.
    store.setActivities(sessionId, []);
    store.cancelRunningActivities(sessionId);
  });
}
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
    const sessionId = decodeURIComponent(String(url).split('/')[3]);
    return response(sessionId);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('keeps at most eight inactive confirmed histories and reloads an evicted conversation on revisit', async () => {
  const { result } = renderHook(() => useSessionStore());
  for (let index = 0; index < 12; index++) await browse(result.current, String(index));
  expect(Array.from({ length: 12 }, (_, index) => String(index)).filter(id => result.current.has(id)))
    .toEqual(['3', '4', '5', '6', '7', '8', '9', '10', '11']);
  expect(result.current.getMessages('11')).toEqual([history('11')]);
  await browse(result.current, '0');
  expect(result.current.getMessages('0')).toEqual([history('0')]);
  expect(authenticatedFetch).toHaveBeenCalledTimes(13);
  expect(result.current.has('3')).toBe(false);
});

it('pins optimistic data, timeline gaps, and active-turn snapshots while evicting clean histories', async () => {
  const { result } = renderHook(() => useSessionStore());
  await browse(result.current, 'optimistic');
  const pending: NormalizedMessage = { ...history('optimistic'), id: 'local-pending', role: 'user', content: 'unsaved request' };
  act(() => result.current.appendRealtime('optimistic', pending));
  await browse(result.current, 'control');
  act(() => result.current.appendRealtime('control', { ...history('control'), kind: 'status' }));
  act(() => result.current.applyTimelineMessage('gap', {
    ...history('gap'), id: 'block', kind: 'stream_delta', content: 'late chunk', turnId: 'turn',
    timeline: { version: 1, turnId: 'turn', id: 'block', order: 1, revision: 1, offset: 50 },
  }));
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({
    messages: [history('snapshot')], total: 1, hasMore: false,
    stream: { messages: [{ ...history('snapshot'), id: 'live', kind: 'stream_delta', turnId: 'running',
      timeline: { version: 1, turnId: 'running', id: 'live', order: 0, revision: 1 } }] },
  })));
  await browse(result.current, 'snapshot');
  for (let index = 0; index < 12; index++) await browse(result.current, String(index));
  expect(result.current.has('0')).toBe(false);
  expect(result.current.getMessages('optimistic').some(message => message.content === 'unsaved request')).toBe(true);
  expect(result.current.getSessionSlot('gap')?.timeline?.hasGap).toBe(true);
  expect(result.current.has('control')).toBe(true);
  expect(result.current.getMessages('snapshot').some(message => message.streamState === 'open')).toBe(true);
});

it('keeps incomplete persisted tool calls but can discard history with paired tool results', async () => {
  const { result } = renderHook(() => useSessionStore());
  const call: NormalizedMessage = { ...history('tools'), kind: 'tool_use', toolId: 'call', toolName: 'read_file' };
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ messages: [call], total: 1, hasMore: false })));
  await browse(result.current, 'incomplete');
  vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ messages: [call,
    { ...call, id: 'result', kind: 'tool_result', content: 'saved result' }], total: 2, hasMore: false })));
  await browse(result.current, 'complete');
  for (let index = 0; index < 12; index++) await browse(result.current, String(index));
  expect(result.current.getMessages('incomplete')).toEqual([call]);
  expect(result.current.has('complete')).toBe(false);
});

it('pins in-flight history loads and does not confirm a slot mutated while its response was pending', async () => {
  const { result } = renderHook(() => useSessionStore());
  let resolve!: (response: Response) => void;
  vi.mocked(authenticatedFetch).mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  let request!: ReturnType<SessionStore['fetchFromServer']>;
  act(() => { request = result.current.fetchFromServer('pending'); });
  for (let index = 0; index < 12; index++) await browse(result.current, String(index));
  expect(result.current.has('pending')).toBe(true);
  act(() => result.current.appendRealtime('pending', { ...history('pending'), id: 'local-after-request', role: 'user', content: 'new input' }));
  await act(async () => { resolve(response('pending')); await request; });
  for (let index = 12; index < 22; index++) await browse(result.current, String(index));
  expect(result.current.getMessages('pending').some(message => message.content === 'new input')).toBe(true);
});
