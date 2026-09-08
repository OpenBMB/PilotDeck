import { describe, expect, it, vi } from 'vitest';
import { createGatewayConnectionCache } from './gatewayConnectionCache.js';

function createFakeGateway(name) {
  const disconnectHandlers = [];
  return {
    name,
    onDisconnect(handler) {
      disconnectHandlers.push(handler);
    },
    disconnect(error = new Error('Gateway WebSocket closed.')) {
      for (const handler of disconnectHandlers.splice(0)) handler(error);
    },
  };
}

describe('gateway connection cache', () => {
  it('replaces a disconnected shared connection and coalesces callers', async () => {
    const first = createFakeGateway('first');
    const second = createFakeGateway('second');
    const connect = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();
    const cache = createGatewayConnectionCache({ connect, onConnected, onDisconnected });

    const [left, right] = await Promise.all([cache.get(), cache.get()]);
    expect(left).toBe(first);
    expect(right).toBe(first);
    expect(connect).toHaveBeenCalledTimes(1);

    first.disconnect();

    const replacement = await cache.get();
    expect(replacement).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onConnected).toHaveBeenNthCalledWith(1, first);
    expect(onConnected).toHaveBeenNthCalledWith(2, second);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale disconnect invalidate the replacement', async () => {
    const first = createFakeGateway('first');
    const second = createFakeGateway('second');
    const connect = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const cache = createGatewayConnectionCache({ connect });

    await cache.get();
    cache.invalidate(first);
    await cache.get();
    first.disconnect();

    expect(await cache.get()).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('allows a later caller to retry after connection setup fails', async () => {
    const gateway = createFakeGateway('replacement');
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValueOnce(gateway);
    const cache = createGatewayConnectionCache({ connect });

    await expect(cache.get()).rejects.toThrow('not ready');
    await expect(cache.get()).resolves.toBe(gateway);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('proactively reconnects when a notification subscriber requires the connection', async () => {
    vi.useFakeTimers();
    try {
      const first = createFakeGateway('first');
      const second = createFakeGateway('second');
      const connect = vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      const onConnected = vi.fn();
      const cache = createGatewayConnectionCache({
        connect,
        onConnected,
        shouldReconnect: () => true,
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 1000,
      });

      await cache.get();
      first.disconnect();

      expect(connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(cache.current()).toBe(second);
      expect(onConnected).toHaveBeenNthCalledWith(2, second);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses bounded backoff after a proactive reconnect attempt fails', async () => {
    vi.useFakeTimers();
    try {
      const first = createFakeGateway('first');
      const replacement = createFakeGateway('replacement');
      const connect = vi.fn()
        .mockResolvedValueOnce(first)
        .mockRejectedValueOnce(new Error('gateway still starting'))
        .mockResolvedValueOnce(replacement);
      const cache = createGatewayConnectionCache({
        connect,
        shouldReconnect: () => true,
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 150,
      });

      await cache.get();
      first.disconnect();
      await vi.advanceTimersByTimeAsync(100);
      expect(connect).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(149);
      expect(connect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(connect).toHaveBeenCalledTimes(3);
      expect(cache.current()).toBe(replacement);
    } finally {
      vi.useRealTimers();
    }
  });
});
