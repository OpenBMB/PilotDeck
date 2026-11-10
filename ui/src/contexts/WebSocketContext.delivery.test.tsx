import { useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocketProvider, useWebSocket } from './WebSocketContext';
import { useProjectsState } from '../hooks/useProjectsState';
import { TaskMasterProvider } from '../components/task-master/context/TaskMasterContext';
import { api } from '../utils/api';

const auth = vi.hoisted(() => ({ token: 'fixture', user: { id: 1 }, isLoading: false }));
vi.mock('../components/auth/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/chat/utils/globalModelSelection', () => ({
  globalModelSelectionStore: { invalidate: vi.fn(), receiveMessage: vi.fn(), trackMessage: vi.fn() },
}));
vi.mock('../utils/api', () => ({ api: { projects: vi.fn(), get: vi.fn() } }));

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { super(); Socket.instances.push(this); }
  send() {}
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.dispatchEvent(new Event('close')); this.onclose?.(); }
}

const activeSessions = new Set<string>();
const navigate = vi.fn();
function Projects() {
  const transport = useWebSocket();
  const state = useProjectsState({ ...transport, navigate, activeSessions, isMobile: false });
  return <>
    <output data-testid="projects">{state.projects.map(project => project.name).join(',')}</output>
    <output data-testid="progress">{state.sidebarSharedProps.loadingProgress?.phase}</output>
  </>;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', Socket);
  vi.mocked(api.projects).mockResolvedValue(new Response('[]', { headers: { 'X-Projects-Revision': '10' } }));
  vi.mocked(api.get).mockImplementation(async (path) => new Response(JSON.stringify(path === '/projects' ? [] : {})));
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); Socket.instances = []; localStorage.clear();
});

it('delivers every frame in order without rerendering transport-only consumers', () => {
  const received: unknown[] = [];
  let renders = 0;
  function Consumer() {
    const { subscribe, isConnected } = useWebSocket();
    renders++;
    useEffect(() => subscribe(message => { received.push(message); }), [subscribe]);
    return <output>{String(isConnected)}</output>;
  }
  render(<WebSocketProvider><Consumer /></WebSocketProvider>);
  const socket = Socket.instances[0];
  act(() => socket.onopen?.());
  const connectedRenders = renders;
  const frames = Array.from({ length: 100 }, (_, index) => ({ type: 'stream_delta', sessionId: 'fixture', delta: String(index) }));
  act(() => frames.forEach(frame => socket.receive(frame)));
  expect(received).toEqual(frames);
  expect(renders).toBe(connectedRenders);
  act(() => socket.close());
  expect(screen.getByText('false')).toBeTruthy();
  expect(renders).toBeGreaterThan(connectedRenders);
});

it('retains project and loading updates when an unrelated frame follows in the same batch', async () => {
  render(<WebSocketProvider><Projects /></WebSocketProvider>);
  await waitFor(() => expect(api.projects).toHaveBeenCalledOnce());
  const socket = Socket.instances[0];
  act(() => {
    socket.receive({ type: 'projects_updated', projectListRevision: 20,
      projects: [{ name: 'created', displayName: 'Created', fullPath: '/fixture', sessions: [] }] });
    socket.receive({ type: 'loading_progress', phase: 'complete' });
    socket.receive({ type: 'stream_delta', delta: 'unrelated' });
  });
  expect(screen.getByTestId('projects').textContent).toBe('created');
  expect(screen.getByTestId('progress').textContent).toBe('complete');
});

it('delivers independent task refresh events before a later stream frame', async () => {
  render(<WebSocketProvider><TaskMasterProvider><div>Tasks</div></TaskMasterProvider></WebSocketProvider>);
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  vi.mocked(api.get).mockClear();
  act(() => {
    const socket = Socket.instances[0];
    socket.receive({ type: 'taskmaster-project-updated', projectName: 'fixture' });
    socket.receive({ type: 'taskmaster-mcp-status-changed' });
    socket.receive({ type: 'stream_delta', delta: 'unrelated' });
  });
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(api.get).toHaveBeenCalledWith('/projects');
  expect(api.get).toHaveBeenCalledWith('/mcp-utils/taskmaster-server');
});
