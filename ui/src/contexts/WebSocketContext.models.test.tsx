import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketProvider } from './WebSocketContext';
const invalidate = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ token: 'fixture' as string | null }));
const config = vi.hoisted(() => ({ IS_PLATFORM: false, DISABLE_LOCAL_AUTH: false }));
vi.mock('../constants/config', () => config);
vi.mock('../components/chat/utils/globalModelSelection', () => ({ globalModelSelectionStore: { invalidate, receiveMessage: vi.fn(), trackMessage: vi.fn() } }));
vi.mock('../components/auth/context/AuthContext', () => ({ useAuth: () => ({ token: auth.token }) }));

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  url: string;
  constructor(url: string) { super(); this.url = url; Socket.instances.push(this); }
  send() {}
  close() { this.dispatchEvent(new Event('close')); this.onclose?.(); }
}

afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); invalidate.mockClear(); Socket.instances = []; auth.token = 'fixture'; config.DISABLE_LOCAL_AUTH = false;
});

it('connects without a login token when local authentication is disabled', () => {
  auth.token = null;
  config.DISABLE_LOCAL_AUTH = true;
  vi.stubGlobal('WebSocket', Socket);
  render(<WebSocketProvider><div>Chat</div></WebSocketProvider>);
  expect(Socket.instances).toHaveLength(1);
  expect(Socket.instances[0].url).toMatch(/\/ws$/);
});

it('waits for a login token before opening a non-platform socket', () => {
  auth.token = null;
  vi.stubGlobal('WebSocket', Socket);
  const view = render(<WebSocketProvider><div>Chat</div></WebSocketProvider>);
  expect(Socket.instances).toHaveLength(0);

  auth.token = 'logged-in';
  view.rerender(<WebSocketProvider><div>Chat</div></WebSocketProvider>);
  expect(Socket.instances).toHaveLength(1);
  expect(Socket.instances[0].url).toContain('/ws?token=logged-in');
});

it('invalidates the catalog on config changes and reconnect even without a mounted composer', () => {
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket);
  render(<WebSocketProvider><div>Settings</div></WebSocketProvider>);
  const first = Socket.instances[0];
  act(() => first.onopen?.());
  act(() => first.onmessage?.({ data: JSON.stringify({ type: 'stream_delta' }) }));
  expect(invalidate).not.toHaveBeenCalled();
  act(() => first.onmessage?.({ data: JSON.stringify({ type: 'config:reloaded' }) }));
  expect(invalidate).toHaveBeenCalledTimes(1);
  act(() => first.close());
  act(() => vi.advanceTimersByTime(1000));
  act(() => Socket.instances[1].onopen?.());
  expect(invalidate).toHaveBeenCalledTimes(2);
});
