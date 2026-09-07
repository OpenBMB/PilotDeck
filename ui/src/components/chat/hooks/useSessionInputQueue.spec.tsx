import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionInputQueue } from './useSessionInputQueue';

describe('useSessionInputQueue session boundaries', () => {
  it('cancels an old-session operation instead of applying it after navigation', async () => {
    let listener: ((message: any) => void) | undefined;
    const sendMessage = vi.fn();
    const ws = { readyState: WebSocket.OPEN } as WebSocket;
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionInputQueue({
        sessionId,
        ws,
        sendMessage,
        subscribe: (handler) => {
          listener = handler;
          return () => undefined;
        },
      }),
      { initialProps: { sessionId: 'web:session-1' } },
    );

    let operation!: Promise<{ ok: boolean; error?: string }>;
    act(() => {
      operation = result.current.resume();
    });
    const request = sendMessage.mock.calls.at(-1)?.[0];

    rerender({ sessionId: 'web:session-2' });
    await expect(operation).resolves.toEqual({
      ok: false,
      error: 'Queue operation was cancelled.',
    });

    act(() => listener?.({
      type: 'input-queue-operation-result',
      requestId: request.requestId,
      sessionId: 'web:session-1',
      ok: true,
    }));
    expect(result.current.queueState.sessionId).toBe('web:session-2');
  });
});
