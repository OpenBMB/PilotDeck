import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSessionStore } from './useSessionStore';
import { authenticatedFetch } from '../utils/api';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn(), readAgentStatusErrorFromResponse: vi.fn() }));
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
beforeEach(() => {
  frames = new Map(); frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('cancels pending notifications on unmount and does not reschedule after an in-flight history load', async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(authenticatedFetch).mockReturnValue(new Promise<Response>(done => { resolve = done; }));
  const { result, unmount } = renderHook(() => useSessionStore());
  act(() => result.current.setActiveSession('fixture'));
  let request!: ReturnType<typeof result.current.fetchFromServer>;
  act(() => { request = result.current.fetchFromServer('fixture'); });
  expect(frames.size).toBe(1);
  unmount();
  expect(frames.size).toBe(0);
  await act(async () => {
    resolve(new Response(JSON.stringify({ messages: [], total: 0, hasMore: false })));
    await request;
  });
  expect(frames.size).toBe(0);
});

it('continues batching active-session notifications after StrictMode effect replay', () => {
  const { result, unmount } = renderHook(() => useSessionStore(), { wrapper: StrictMode });
  act(() => result.current.setActiveSession('fixture'));
  act(() => {
    result.current.appendRealtime('fixture', {
      id: 'message', sessionId: 'fixture', timestamp: '2026-01-01T00:00:00Z', provider: 'pilotdeck',
      kind: 'text', role: 'assistant', content: 'visible response',
    });
  });
  expect(frames.size).toBe(1);
  act(() => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(0));
  });
  expect(result.current.getMessages('fixture')[0].content).toBe('visible response');
  unmount();
  expect(frames.size).toBe(0);
});
