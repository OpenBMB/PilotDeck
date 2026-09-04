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
});
