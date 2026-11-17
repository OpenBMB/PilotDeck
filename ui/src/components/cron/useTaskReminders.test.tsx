// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTaskReminders } from './useTaskReminders';

const mock = vi.hoisted(() => ({ user: { id: 1 } as { id?: number }, listeners: new Set<(message: any) => void>(), pending: [] as any[],
  subscribe: (listener: any) => { mock.listeners.add(listener); return () => mock.listeners.delete(listener); },
  fetch: vi.fn(), show: vi.fn(async (_payload: any) => true), worker: vi.fn(async (_type: string, _value?: unknown): Promise<unknown> => undefined), close: undefined as undefined | ((value: any) => void), failClose: false,
  preferences: { enabled: true, sound: true, badge: true, preview: true } }));
vi.mock('../auth/context/AuthContext', () => ({ useAuth: () => ({ user: mock.user }) }));
vi.mock('../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ isConnected: true, subscribe: mock.subscribe }) }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mock.fetch }));
vi.mock('../../hooks/useNotificationPreferences', () => ({ useNotificationPreferences: () => ({ preferences: mock.preferences, status: { permission: 'granted' } }) }));
vi.mock('../../lib/systemNotifications', () => ({ showSystemNotification: mock.show, notificationWorkerMessage: mock.worker }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
const reminder = { id: 'a'.repeat(64), taskId: 'task-a', projectKey: '/synthetic', sessionKey: 'cron:task-a', title: 'Meeting', body: 'Internal execution instructions',
  kind: 'due', createdAt: '2026-11-16T12:00:00Z', occurrenceAt: '2026-11-16T12:00:00Z' };
function Probe() { useTaskReminders(); return <main>Application content</main>; }
function setup(pending = [reminder]) {
  mock.pending = pending; mock.failClose = false; mock.user = { id: 1 }; mock.preferences.enabled = true;
  mock.show.mockResolvedValue(true);
  mock.fetch.mockImplementation(async (_path: string, options: any) => {
    if (options?.method === 'POST') {
      if (mock.failClose) return new Response('{}', { status: 503 });
      mock.pending = []; return new Response('{"dismissed":true}');
    }
    return new Response(JSON.stringify({ scope: '1', reminders: mock.pending }));
  });
  return render(<Probe />);
}
const emit = (message: any) => act(() => { for (const listener of mock.listeners) listener(message); });
const focus = () => act(() => window.dispatchEvent(new Event('focus')));
afterEach(() => { cleanup(); vi.useRealTimers(); mock.listeners.clear(); mock.fetch.mockReset(); mock.show.mockReset(); mock.worker.mockReset(); localStorage.clear(); window.pilotdeckDesktop = undefined; });

it('replays worker dismissals after the last page closed and retains them through a failed server acknowledgement', async () => {
  const dismissal = { scope: '1', id: reminder.id };
  let outbox = [dismissal];
  mock.worker.mockImplementation(async (type: string) => {
    if (type === 'notification:task-pending-dismissals') return outbox;
    if (type === 'notification:task-acknowledged') outbox = [];
  });
  setup(); mock.failClose = true;
  await waitFor(() => expect(mock.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1));
  expect(outbox).toEqual([dismissal]);
  expect(mock.show).not.toHaveBeenCalled();
  mock.failClose = false; focus();
  await waitFor(() => expect(outbox).toEqual([]));
  expect(mock.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(2);
  expect(mock.show).not.toHaveBeenCalled();
});

it('uses system delivery without cards, task-read acknowledgement or periodic queries; restart does not repeat delivered alerts', async () => {
  const view = setup();
  await waitFor(() => expect(mock.show).toHaveBeenCalledOnce());
  const payload = mock.show.mock.calls[0][0] as any;
  expect(payload).toMatchObject({ persistent: true, silent: true, data: { kind: 'reminder', taskId: 'task-a', scope: '1' } });
  expect(payload.body).not.toContain('Internal execution instructions');
  expect(view.container.textContent).toBe('Application content');
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  vi.useFakeTimers(); act(() => { vi.advanceTimersByTime(60_000); }); vi.useRealTimers();
  expect(mock.fetch).toHaveBeenCalledOnce();
  act(() => window.dispatchEvent(new CustomEvent('pilotdeck:notification-navigate', { detail: payload.data })));
  expect(mock.fetch.mock.calls.some(call => call[1]?.method === 'POST')).toBe(false);
  view.unmount(); render(<Probe />);
  await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(2));
  expect(mock.show).toHaveBeenCalledOnce();
});
it('retries a failed OS delivery on focus without consuming its receipt', async () => {
  setup(); mock.show.mockResolvedValueOnce(false).mockResolvedValue(true);
  await waitFor(() => expect(mock.show).toHaveBeenCalledOnce());
  focus(); await waitFor(() => expect(mock.show).toHaveBeenCalledTimes(2));
  focus(); await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(3));
  expect(mock.show).toHaveBeenCalledTimes(2);
});
it('deduplicates live events, ignores ordinary chat and other accounts, and closes only explicitly acknowledged reminders', async () => {
  setup([]); await waitFor(() => expect(mock.fetch).toHaveBeenCalledOnce()); await act(async () => {});
  emit({ type: 'session-notification', notification: { sessionId: 'chat', kind: 'completed' } });
  emit({ type: 'cron-reminder-changed', scope: 'other', id: reminder.id, reminder });
  expect(mock.show).not.toHaveBeenCalled();
  emit({ type: 'cron-reminder-changed', scope: '1', id: reminder.id, reminder });
  emit({ type: 'cron-reminder-changed', scope: '1', id: reminder.id, reminder });
  await waitFor(() => expect(mock.show).toHaveBeenCalledOnce());
  expect(mock.show.mock.calls[0][0]).toMatchObject({ silent: false });
  emit({ type: 'cron-reminder-changed', scope: '1', id: reminder.id, dismissedScope: '1' });
  expect(mock.worker).toHaveBeenCalledWith('notification:task-dismiss', { scope: '1', id: reminder.id });
});
it('binds the server scope for account-free clients and retries a failed explicit native dismissal acknowledgement', async () => {
  const view = setup([]); view.unmount(); mock.user = {};
  window.pilotdeckDesktop = { setNotificationScope: vi.fn(async () => {}), onSystemNotificationDismiss: (callback: (value: { scope: string; id: string }) => void) => { mock.close = callback; return () => { mock.close = undefined; }; } } as any;
  render(<Probe />); await act(async () => {});
  emit({ type: 'cron-reminder-changed', scope: '1', id: reminder.id, reminder });
  await waitFor(() => expect(mock.show).toHaveBeenCalledOnce());
  mock.failClose = true; act(() => mock.close?.({ scope: '1', id: reminder.id }));
  await waitFor(() => expect(mock.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1));
  mock.failClose = false; focus();
  await waitFor(() => expect(mock.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(2));
  expect(mock.show).toHaveBeenCalledOnce();
});
