// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketProvider, useWebSocket } from './WebSocketContext';
import { GLOBAL_MODEL_SELECTION_KEY, readSessionModelSelection } from '../components/chat/utils/globalModelSelection';
vi.mock('../components/auth/context/AuthContext', () => ({ useAuth: () => ({ token: 'fixture' }) }));
class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { super(); Socket.instances.push(this); }
  send = vi.fn();
  close() { this.dispatchEvent(new Event('close')); this.onclose?.(); }
}
const selection = { mode: 'model', provider: 'HXAPI', model: 'example', reasoning: .8 };
function Composer() {
  const { sendMessage } = useWebSocket();
  return <button onClick={() => sendMessage({ type: 'pilotdeck-command', options: { projectPath: '/project', runId: 'run-browser', modelSelection: selection } })}>Send</button>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Socket.instances = []; localStorage.clear(); });
it('records only a server-confirmed frame and continues to record after the composer unmounts', () => {
  localStorage.clear(); vi.stubGlobal('WebSocket', Socket);
  const view = render(<WebSocketProvider><Composer /></WebSocketProvider>);
  const socket = Socket.instances[0]; act(() => socket.onopen?.());
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).options.modelSelection).toEqual(selection);
  expect(localStorage.getItem(GLOBAL_MODEL_SELECTION_KEY)).toBeNull();
  view.rerender(<WebSocketProvider><div>Settings</div></WebSocketProvider>);
  act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'model-selection-saved', runId: 'run-browser', sessionId: 'web:created', selection }) }));
  expect(JSON.parse(localStorage.getItem(GLOBAL_MODEL_SELECTION_KEY)!)).toEqual(selection);
  expect(readSessionModelSelection('/project', 'web:created')).toEqual(selection);
});
it('does not track a frame rejected by the local socket', () => {
  localStorage.clear(); vi.stubGlobal('WebSocket', Socket);
  render(<WebSocketProvider><Composer /></WebSocketProvider>);
  const socket = Socket.instances[0]; act(() => socket.onopen?.());
  socket.send.mockImplementation(() => { throw new Error('Disconnected'); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'model-selection-saved', runId: 'run-browser', sessionId: 'web:other' }) }));
  expect(localStorage.getItem(GLOBAL_MODEL_SELECTION_KEY)).toBeNull(); warn.mockRestore();
});
