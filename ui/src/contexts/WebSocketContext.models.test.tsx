import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketProvider } from './WebSocketContext';
const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../components/chat/utils/globalModelSelection', () => ({ globalModelSelectionStore: { invalidate } }));
vi.mock('../components/auth/context/AuthContext', () => ({ useAuth: () => ({ token: 'fixture' }) }));

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { super(); Socket.instances.push(this); }
  send() {}
  close() { this.dispatchEvent(new Event('close')); this.onclose?.(); }
}

afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); invalidate.mockClear(); Socket.instances = [];
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
