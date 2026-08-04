// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from './useSessionStore';
import { useSessionStore } from './useSessionStore';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  readAgentStatusErrorFromResponse: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
  readAgentStatusErrorFromResponse: mocks.readAgentStatusErrorFromResponse,
}));

type TestResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function response(body: unknown, ok = true, status = ok ? 200 : 503): TestResponse {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function serverMessage(id: string, content: string): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    timestamp: '2026-08-04T00:00:00.000Z',
    provider: 'pilotdeck',
    kind: 'text',
    role: 'assistant',
    content,
  };
}

describe('useSessionStore server request ordering', () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockReset();
    mocks.readAgentStatusErrorFromResponse.mockReset();
    mocks.readAgentStatusErrorFromResponse.mockResolvedValue({
      message: 'refresh failed',
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps a successful initial load when a later background refresh fails', async () => {
    const initial = deferred<TestResponse>();
    const refresh = deferred<TestResponse>();
    mocks.authenticatedFetch
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const { result } = renderHook(() => useSessionStore());
    let initialRequest!: ReturnType<typeof result.current.fetchFromServer>;
    let refreshRequest!: ReturnType<typeof result.current.refreshFromServer>;
    act(() => {
      initialRequest = result.current.fetchFromServer('session-1');
      refreshRequest = result.current.refreshFromServer('session-1');
    });

    await act(async () => {
      refresh.resolve(response({}, false));
      await refreshRequest;
    });
    await act(async () => {
      initial.resolve(response({
        messages: [serverMessage('initial-message', 'Loaded history')],
        total: 1,
      }));
      await initialRequest;
    });

    const slot = result.current.getSessionSlot('session-1');
    expect(slot?.serverMessages.map((message) => message.id)).toEqual([
      'initial-message',
    ]);
    expect(slot?.status).toBe('idle');
    expect(slot?.lastError).toBeNull();
  });

  it('does not let an empty commit-race refresh supersede an initial load', async () => {
    const initial = deferred<TestResponse>();
    const refresh = deferred<TestResponse>();
    mocks.authenticatedFetch
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const { result } = renderHook(() => useSessionStore());
    let initialRequest!: ReturnType<typeof result.current.fetchFromServer>;
    let refreshRequest!: ReturnType<typeof result.current.refreshFromServer>;
    act(() => {
      initialRequest = result.current.fetchFromServer('session-1');
      refreshRequest = result.current.refreshFromServer('session-1');
    });

    await act(async () => {
      refresh.resolve(response({ messages: [], total: 0 }));
      await refreshRequest;
    });
    expect(result.current.getSessionSlot('session-1')?.status).toBe('loading');

    await act(async () => {
      initial.resolve(response({
        messages: [serverMessage('initial-message', 'Loaded history')],
        total: 1,
      }));
      await initialRequest;
    });

    expect(result.current.getSessionSlot('session-1')?.serverMessages.map(
      (message) => message.id,
    )).toEqual(['initial-message']);
    expect(result.current.getSessionSlot('session-1')?.status).toBe('idle');
  });

  it('still prevents an older initial response from replacing a newer successful refresh', async () => {
    const initial = deferred<TestResponse>();
    const refresh = deferred<TestResponse>();
    mocks.authenticatedFetch
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const { result } = renderHook(() => useSessionStore());
    let initialRequest!: ReturnType<typeof result.current.fetchFromServer>;
    let refreshRequest!: ReturnType<typeof result.current.refreshFromServer>;
    act(() => {
      initialRequest = result.current.fetchFromServer('session-1');
      refreshRequest = result.current.refreshFromServer('session-1');
    });

    await act(async () => {
      refresh.resolve(response({
        messages: [serverMessage('refreshed-message', 'Newest history')],
        total: 1,
      }));
      await refreshRequest;
    });
    await act(async () => {
      initial.resolve(response({
        messages: [serverMessage('stale-message', 'Stale history')],
        total: 1,
      }));
      await initialRequest;
    });

    const slot = result.current.getSessionSlot('session-1');
    expect(slot?.serverMessages.map((message) => message.id)).toEqual([
      'refreshed-message',
    ]);
    expect(slot?.status).toBe('idle');
  });

  it('clears a superseded load without resetting an active streaming status', async () => {
    const initial = deferred<TestResponse>();
    const refresh = deferred<TestResponse>();
    mocks.authenticatedFetch
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const { result } = renderHook(() => useSessionStore());
    let initialRequest!: ReturnType<typeof result.current.fetchFromServer>;
    let refreshRequest!: ReturnType<typeof result.current.refreshFromServer>;
    act(() => {
      initialRequest = result.current.fetchFromServer('session-1');
      result.current.setStatus('session-1', 'streaming');
      refreshRequest = result.current.refreshFromServer('session-1');
    });

    await act(async () => {
      refresh.resolve(response({
        messages: [serverMessage('refreshed-message', 'Newest history')],
        total: 1,
      }));
      await refreshRequest;
    });

    let slot = result.current.getSessionSlot('session-1');
    expect(slot?.status).toBe('streaming');
    expect(slot?._serverLoadingGeneration).toBeNull();

    await act(async () => {
      initial.resolve(response({
        messages: [serverMessage('stale-message', 'Stale history')],
        total: 1,
      }));
      await initialRequest;
    });

    slot = result.current.getSessionSlot('session-1');
    expect(slot?.serverMessages.map((message) => message.id)).toEqual([
      'refreshed-message',
    ]);
    expect(slot?.status).toBe('streaming');
  });

  it('does not reset streaming status when its own initial load completes', async () => {
    const initial = deferred<TestResponse>();
    mocks.authenticatedFetch.mockImplementationOnce(() => initial.promise);

    const { result } = renderHook(() => useSessionStore());
    let initialRequest!: ReturnType<typeof result.current.fetchFromServer>;
    act(() => {
      initialRequest = result.current.fetchFromServer('session-1');
      result.current.setStatus('session-1', 'streaming');
    });

    await act(async () => {
      initial.resolve(response({
        messages: [serverMessage('initial-message', 'Loaded history')],
        total: 1,
      }));
      await initialRequest;
    });

    const slot = result.current.getSessionSlot('session-1');
    expect(slot?._serverLoadingGeneration).toBeNull();
    expect(slot?.status).toBe('streaming');
  });
});
