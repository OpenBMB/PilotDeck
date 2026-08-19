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

function userMessage(
  id: string,
  content: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    ...serverMessage(id, content),
    timestamp,
    role: 'user',
    ...overrides,
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

  it('does not confirm an optimistic send from older history loaded after it', async () => {
    const initial = deferred<TestResponse>();
    mocks.authenticatedFetch.mockImplementationOnce(() => initial.promise);

    const { result } = renderHook(() => useSessionStore());
    let initialRequest!: ReturnType<typeof result.current.fetchFromServer>;
    act(() => {
      initialRequest = result.current.fetchFromServer('session-1');
      result.current.appendRealtime(
        'session-1',
        userMessage('local_new_send', 'Continue.', '2026-08-04T00:00:05.000Z'),
      );
    });

    expect(result.current.getSessionSlot('session-1')?.realtimeMessages[0]).toMatchObject({
      id: 'local_new_send',
      serverTailIdAtStart: null,
      serverHistoryPendingAtStart: true,
    });

    await act(async () => {
      initial.resolve(response({
        messages: [userMessage('persisted-old-send', 'Continue.', '2026-08-04T00:00:00.000Z')],
        total: 1,
      }));
      await initialRequest;
    });

    expect(result.current.getSessionSlot('session-1')?.realtimeMessages).toEqual([
      expect.objectContaining({
        id: 'local_new_send',
        serverTailIdAtStart: 'persisted-old-send',
        serverHistoryPendingAtStart: false,
      }),
    ]);
  });

  it('treats a sibling optimistic send as pending before history loading starts', async () => {
    const initial = deferred<TestResponse>();
    mocks.authenticatedFetch.mockImplementationOnce(() => initial.promise);

    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(
        'session-1',
        userMessage('local_ws_user_new_send', 'Continue.', '2026-08-04T00:00:05.000Z'),
      );
    });

    expect(result.current.getSessionSlot('session-1')?.realtimeMessages[0]).toMatchObject({
      id: 'local_ws_user_new_send',
      serverTailIdAtStart: null,
      serverHistoryPendingAtStart: true,
    });

    let initialRequest!: ReturnType<typeof result.current.fetchFromServer>;
    act(() => {
      initialRequest = result.current.fetchFromServer('session-1');
    });
    await act(async () => {
      initial.resolve(response({
        messages: [userMessage('persisted-old-send', 'Continue.', '2026-08-04T00:00:00.000Z')],
        total: 1,
      }));
      await initialRequest;
    });

    expect(result.current.getSessionSlot('session-1')?.realtimeMessages).toEqual([
      expect.objectContaining({
        id: 'local_ws_user_new_send',
        serverTailIdAtStart: 'persisted-old-send',
        serverHistoryPendingAtStart: false,
      }),
    ]);
  });

  it('keeps optimistic history pending across an empty initial response', async () => {
    const initial = deferred<TestResponse>();
    const refresh = deferred<TestResponse>();
    mocks.authenticatedFetch
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refresh.promise);

    const { result } = renderHook(() => useSessionStore());
    let initialRequest!: ReturnType<typeof result.current.fetchFromServer>;
    act(() => {
      initialRequest = result.current.fetchFromServer('session-1');
      result.current.appendRealtime(
        'session-1',
        userMessage('local_new_send', 'Continue.', '2026-08-04T00:00:05.000Z'),
      );
    });
    await act(async () => {
      initial.resolve(response({ messages: [], total: 0 }));
      await initialRequest;
    });

    expect(result.current.getSessionSlot('session-1')?.realtimeMessages[0]).toMatchObject({
      id: 'local_new_send',
      serverTailIdAtStart: null,
      serverHistoryPendingAtStart: true,
    });
    act(() => {
      result.current.appendRealtime(
        'session-1',
        userMessage('local_after_empty', 'Another message', '2026-08-04T00:00:06.000Z'),
      );
    });
    expect(result.current.getSessionSlot('session-1')?.realtimeMessages[1]).toMatchObject({
      id: 'local_after_empty',
      serverHistoryPendingAtStart: true,
    });

    let refreshRequest!: ReturnType<typeof result.current.refreshFromServer>;
    act(() => {
      refreshRequest = result.current.refreshFromServer('session-1');
    });
    await act(async () => {
      refresh.resolve(response({
        messages: [userMessage('persisted-old-send', 'Continue.', '2026-08-04T00:00:00.000Z')],
        total: 1,
      }));
      await refreshRequest;
    });

    expect(result.current.getSessionSlot('session-1')?.realtimeMessages).toEqual([
      expect.objectContaining({
        id: 'local_new_send',
        serverTailIdAtStart: 'persisted-old-send',
        serverHistoryPendingAtStart: false,
      }),
      expect.objectContaining({
        id: 'local_after_empty',
        serverTailIdAtStart: 'persisted-old-send',
        serverHistoryPendingAtStart: false,
      }),
    ]);
  });

  it('confirms an id-bearing optimistic send during the initial fetch', async () => {
    const initial = deferred<TestResponse>();
    mocks.authenticatedFetch.mockImplementationOnce(() => initial.promise);

    const { result } = renderHook(() => useSessionStore());
    let initialRequest!: ReturnType<typeof result.current.fetchFromServer>;
    act(() => {
      initialRequest = result.current.fetchFromServer('session-1');
      result.current.appendRealtime(
        'session-1',
        userMessage('local_user', 'Continue.', '2026-08-04T00:00:05.000Z', {
          runId: 'run-user-1',
        }),
      );
    });

    expect(result.current.getSessionSlot('session-1')?.realtimeMessages[0]).toMatchObject({
      serverTailIdAtStart: null,
      serverHistoryPendingAtStart: true,
    });

    await act(async () => {
      initial.resolve(response({
        messages: [userMessage('persisted-user', 'Continue.', '2026-08-04T00:00:00.000Z', {
          turnId: 'run-user-1',
          runId: 'run-user-1',
        })],
        total: 1,
      }));
      await initialRequest;
    });

    expect(result.current.getSessionSlot('session-1')?.realtimeMessages).toEqual([]);
  });

  it('keeps a different id-bearing optimistic send during refresh cleanup', async () => {
    const refresh = deferred<TestResponse>();
    mocks.authenticatedFetch.mockImplementationOnce(() => refresh.promise);

    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(
        'session-1',
        userMessage('local_new_user', 'Continue.', '2026-08-04T00:00:05.000Z', {
          runId: 'run-new',
        }),
      );
    });

    let refreshRequest!: ReturnType<typeof result.current.refreshFromServer>;
    act(() => {
      refreshRequest = result.current.refreshFromServer('session-1');
    });
    await act(async () => {
      refresh.resolve(response({
        messages: [userMessage('persisted-old-user', 'Continue.', '2026-08-04T00:00:00.000Z', {
          turnId: 'run-old',
          runId: 'run-old',
        })],
        total: 1,
      }));
      await refreshRequest;
    });

    expect(result.current.getSessionSlot('session-1')?.realtimeMessages).toEqual([
      expect.objectContaining({
        id: 'local_new_user',
        runId: 'run-new',
        serverTailIdAtStart: 'persisted-old-user',
        serverHistoryPendingAtStart: false,
      }),
    ]);
  });
});
