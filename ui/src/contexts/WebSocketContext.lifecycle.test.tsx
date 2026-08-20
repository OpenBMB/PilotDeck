import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketProvider, useWebSocket } from './WebSocketContext';

const { authState } = vi.hoisted(() => ({
  authState: { token: 'token-a' as string | null },
}));

vi.mock('../components/auth/context/AuthContext', () => ({
  useAuth: () => ({ token: authState.token }),
}));

vi.mock('../constants/config', () => ({
  IS_PLATFORM: false,
}));

describe('WebSocketProvider lifecycle', () => {
  beforeEach(() => {
    authState.token = 'token-a';
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('ignores a stale close callback after the auth token changes', () => {
    const hook = renderHook(() => useWebSocket(), { wrapper: ProviderWrapper });
    const first = MockWebSocket.instances[0];
    expect(first.url).toContain('token=token-a');
    act(() => first.open());
    const staleClose = first.onclose;

    authState.token = 'token-b';
    hook.rerender();
    const second = MockWebSocket.instances[1];
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.url).toContain('token=token-b');

    act(() => {
      staleClose?.(new CloseEvent('close'));
      vi.advanceTimersByTime(60_000);
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(hook.result.current.reconnectInfo.attempt).toBe(0);
    hook.unmount();
  });

  it('connects again after the StrictMode effect cleanup and remount', () => {
    const hook = renderHook(() => useWebSocket(), { wrapper: StrictProviderWrapper });

    expect(MockWebSocket.instances).toHaveLength(2);
    act(() => MockWebSocket.instances[0].open());
    expect(MockWebSocket.instances[0].close).toHaveBeenCalledOnce();
    act(() => MockWebSocket.instances[1].open());
    expect(hook.result.current.isConnected).toBe(true);

    hook.unmount();
  });

  it('sends heartbeat pings only while the socket is open', () => {
    const hook = renderHook(() => useWebSocket(), { wrapper: ProviderWrapper });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    act(() => vi.advanceTimersByTime(29_999));
    expect(socket.send).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));

    act(() => socket.serverClose());
    act(() => vi.advanceTimersByTime(29_999));
    expect(socket.send).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('clears the heartbeat when the provider unmounts', () => {
    const hook = renderHook(() => useWebSocket(), { wrapper: ProviderWrapper });
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    act(() => vi.advanceTimersByTime(30_000));
    expect(socket.send).toHaveBeenCalledTimes(1);

    hook.unmount();
    act(() => vi.advanceTimersByTime(60_000));

    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledTimes(1);
  });
});

function ProviderWrapper({ children }: { children: ReactNode }) {
  return <WebSocketProvider>{children}</WebSocketProvider>;
}

function StrictProviderWrapper({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <WebSocketProvider>{children}</WebSocketProvider>
    </StrictMode>
  );
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', new CloseEvent('close'));
    this.onclose?.(new CloseEvent('close'));
  });
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  serverClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    const event = new CloseEvent('close');
    this.dispatch('close', event);
    this.onclose?.(event);
  }

  private dispatch(type: string, event: Event): void {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}
