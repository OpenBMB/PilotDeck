// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import TaskReminderNotifications from './TaskReminderNotifications';

const mock = vi.hoisted(() => ({ user: { id: 1 } as { id?: number }, listeners: new Set<(message: any) => void>(), pending: [] as any[],
  subscribe: (listener: any) => { mock.listeners.add(listener); return () => mock.listeners.delete(listener); },
  fetch: vi.fn(), show: vi.fn(async () => true), worker: vi.fn(async () => undefined), failClose: false,
  preferences: { enabled: true, sound: true, badge: true, preview: true } }));
vi.mock('../../auth/context/AuthContext', () => ({ useAuth: () => ({ user: mock.user }) }));
vi.mock('../../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ isConnected: true,
  subscribe: mock.subscribe }) }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: mock.fetch }));
vi.mock('../../../hooks/useNotificationPreferences', () => ({ useNotificationPreferences: () => ({ preferences: mock.preferences }), getNotificationPreferences: () => mock.preferences }));
vi.mock('../../../lib/systemNotifications', () => ({ showSystemNotification: mock.show, notificationWorkerMessage: mock.worker }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));

const reminder = { id: 'a'.repeat(64), taskId: 'task-a', projectKey: '/synthetic', sessionKey: 'cron:task-a', title: 'Meeting', body: 'Meeting now',
  kind: 'due', createdAt: '2026-11-16T12:00:00Z', occurrenceAt: '2026-11-16T12:00:00Z' };
function Location() { return <output data-testid="location">{useLocation().pathname + useLocation().search}</output>; }
function setup() {
  mock.pending = [reminder]; mock.failClose = false; mock.user = { id: 1 };
  mock.fetch.mockImplementation(async (path: string, options: any) => {
    if (options?.method === 'POST') {
      if (mock.failClose) return new Response('{}', { status: 503 });
      mock.pending = []; return new Response('{"dismissed":true}');
    }
    return new Response(JSON.stringify({ scope: String(mock.user.id), reminders: mock.pending }));
  });
  return render(<MemoryRouter><TaskReminderNotifications /><Location /></MemoryRouter>);
}
afterEach(() => { cleanup(); vi.useRealTimers(); mock.listeners.clear(); mock.fetch.mockReset(); mock.show.mockClear(); localStorage.clear(); window.pilotdeckDesktop = undefined; });

it('retains its card after elapsed time, focus and task navigation until a successful explicit close', async () => {
  setup(); await screen.findByRole('heading', { name: 'Meeting' });
  vi.useFakeTimers(); act(() => { vi.advanceTimersByTime(60_000); window.dispatchEvent(new Event('focus')); }); vi.useRealTimers();
  fireEvent.click(screen.getByRole('button', { name: 'cron.reminders.view' }));
  expect(screen.getByTestId('location').textContent).toBe('/cron?taskId=task-a');
  expect(screen.getByRole('heading', { name: 'Meeting' })).toBeTruthy();
  expect(mock.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
  mock.failClose = true; fireEvent.click(screen.getByRole('button', { name: 'cron.reminders.close' }));
  await screen.findByText('cron.reminders.error'); expect(screen.getByRole('heading', { name: 'Meeting' })).toBeTruthy();
  mock.failClose = false; fireEvent.click(screen.getByRole('button', { name: 'cron.reminders.close' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Meeting' })).toBeNull());
});

it('deduplicates live events without routing normal chat notifications into task cards', async () => {
  setup(); await screen.findByRole('heading', { name: 'Meeting' });
  const emit = (message: any) => act(() => { for (const listener of [...mock.listeners]) listener(message); });
  emit({ type: 'session-notification', notification: { sessionId: 'chat', kind: 'completed' } });
  emit({ type: 'cron-reminder-changed', scope: '1', id: reminder.id, reminder });
  emit({ type: 'cron-reminder-changed', scope: '1', id: reminder.id, reminder });
  expect(screen.getAllByRole('heading', { name: 'Meeting' })).toHaveLength(1);
  expect(mock.show).toHaveBeenCalledTimes(1);
  emit({ type: 'cron-reminder-changed', scope: 'other', id: 'different', reminder: { ...reminder, id: 'different', title: 'Other account' } });
  expect(screen.queryByText('Other account')).toBeNull();
});

it('binds the authenticated server scope when account-free clients have no user ID', async () => {
  setup(); await screen.findByRole('heading', { name: 'Meeting' });
  cleanup(); mock.user = {}; mock.pending = [];
  mock.fetch.mockResolvedValue(new Response(JSON.stringify({ scope: '1', reminders: [] })));
  render(<MemoryRouter><TaskReminderNotifications /></MemoryRouter>);
  await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(2));
  await act(async () => {});
  act(() => { for (const listener of mock.listeners) listener({ type: 'cron-reminder-changed', scope: '1', id: reminder.id, reminder }); });
  await screen.findByRole('heading', { name: 'Meeting' });
  expect(mock.show).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scope: '1' }) }));
});
