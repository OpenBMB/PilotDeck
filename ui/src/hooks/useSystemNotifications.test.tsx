// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionIndicatorStore } from '../components/app-shell/useSessionIndicators';
import { useSystemNotifications } from './useSystemNotifications';
import { createDesktopNotifications } from '../../../apps/desktop/src/notifications';

const mocks = vi.hoisted(() => ({
  preferences: { enabled: true, sound: true, badge: true, preview: true },
  show: vi.fn(async (_payload: any) => true), clearBadge: vi.fn(async () => {}),
  worker: vi.fn(async (_type: string, _value: any) => undefined),
}));
vi.mock('./useNotificationPreferences', () => ({
  useNotificationPreferences: () => ({ preferences: mocks.preferences, status: { permission: 'granted' } }),
  getNotificationPreferences: () => mocks.preferences,
}));
vi.mock('./useWebPush', () => ({ syncWebPush: vi.fn(async () => {}) }));
vi.mock('../lib/systemNotifications', () => ({ showSystemNotification: mocks.show, clearWebNotificationBadge: mocks.clearBadge, notificationWorkerMessage: mocks.worker }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers(); mocks.show.mockClear(); mocks.clearBadge.mockClear(); window.pilotdeckDesktop = undefined; mocks.preferences.enabled = true; mocks.worker.mockClear(); mocks.preferences.preview = true; });
function setup(viewedSessionId: string | null = 's1') {
  let receive: (message: any) => void = () => {};
  const subscribe = (listener: typeof receive) => { receive = listener; return () => {}; };
  const store = createSessionIndicatorStore('test', localStorage);
  const hook = renderHook(({ connected }) => useSystemNotifications({ store, viewedSessionId, scope: '1', subscribe,
    isConnected: connected, sessionNames: { s1: 'Report', s2: 'Other report' } }), { initialProps: { connected: true } });
  return { store, emit: (message: any) => act(() => receive(message)), ...hook };
}
const event = (sessionId = 's1', id = 'r1') => ({ type: 'session-notification', notification: {
  id, sessionId, scope: '1', kind: 'completed', preview: 'Private summary', createdAt: '2026-10-27T03:00:00Z',
} });
it('does not display or count delayed reminders after a newer reminder was read', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const { store, emit } = setup();
  const newer = event('s2', 'r2');
  newer.notification.createdAt = '2026-10-27T03:01:00Z';
  emit(newer);
  act(() => store.markRead('s2'));
  expect(mocks.worker).toHaveBeenCalledWith('notification:read', expect.objectContaining({
    records: [{ sessionId: 's2', id: 'r2', createdAt: newer.notification.createdAt }],
  }));
  emit(event('s2', 'r1'));
  expect(mocks.show).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().unreadSessionIds.size).toBe(0);
  const next = event('s2', 'r3');
  next.notification.createdAt = '2026-10-27T03:02:00Z';
  emit(next);
  expect(mocks.show).toHaveBeenCalledTimes(2);
  expect(store.unreadRun('s2')).toBe('r3');
});
it('does not replay a reminder already read from the activity stream', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const { store, emit } = setup();
  emit({ type: 'session-activity', activity: { sessionId: 's2', attentionId: 'r1', attentionAt: event().notification.createdAt } });
  act(() => store.markRead('s2'));
  emit(event('s2'));
  expect(mocks.show).not.toHaveBeenCalled();
});
it('suppresses foreground notifications, counts distinct background conversations, and deduplicates replays', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const { store, emit } = setup();
  emit(event());
  expect(mocks.show).not.toHaveBeenCalled();
  expect(store.getSnapshot().unreadSessionIds.size).toBe(0);
  emit(event('s2'));
  expect(mocks.show).toHaveBeenCalledTimes(1);
  expect(mocks.show.mock.calls[0][0]).toMatchObject({ title: 'Other report' });
  expect(store.getSnapshot().unreadSessionIds.size).toBe(1);
  act(() => store.markRead('s2'));
  emit(event('s2'));
  expect(mocks.show).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().unreadSessionIds.size).toBe(0);
});
it('keeps hidden selected conversations unread, removes previews, and clears on actual focus', () => {
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  mocks.preferences.preview = false;
  const { store, emit } = setup();
  emit(event());
  expect(mocks.show.mock.calls[0][0].body).not.toContain('Private summary');
  expect(store.getSnapshot().unreadSessionIds.has('s1')).toBe(true);
  focus.mockReturnValue(true);
  act(() => window.dispatchEvent(new Event('focus')));
  expect(store.getSnapshot().unreadSessionIds.size).toBe(0);
});
it('waits through brief disconnects and reminds once for running conversations after 15 seconds', () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const { store, emit, rerender } = setup();
  emit({ type: 'session-activity', activity: { sessionId: 's1', runId: 'r1', processing: true } });
  rerender({ connected: false });
  act(() => vi.advanceTimersByTime(14000));
  expect(mocks.show).not.toHaveBeenCalled();
  rerender({ connected: true });
  act(() => vi.advanceTimersByTime(5000));
  expect(mocks.show).not.toHaveBeenCalled();
  rerender({ connected: false });
  act(() => vi.advanceTimersByTime(15000));
  expect(mocks.show).toHaveBeenCalledTimes(1);
  expect(mocks.show.mock.calls[0][0]).toMatchObject({ title: 'Report', data: { kind: 'disconnected', taskId: 'r1' } });
  expect(store.getSnapshot().unreadSessionIds.size).toBe(1);
  act(() => vi.advanceTimersByTime(60000));
  expect(mocks.show).toHaveBeenCalledTimes(1);
});

it.each(['darwin', 'win32', 'linux'])('%s: task badges clear on native focus while other conversation unread dots remain', platform => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  let foreground = false;
  let count = 0;
  const native = createDesktopNotifications({
    platform, now: () => Date.now(), isForeground: () => foreground, supported: () => false,
    read: () => mocks.preferences, save: () => {}, create: () => { throw new Error('No OS banners during a badge test'); },
    setBadge: () => {}, setOverlay: () => {}, setTrayBadge: value => { count = value; }, navigate: async () => {}, report: () => {},
  });
  const record = vi.fn(async payload => native.record(payload));
  window.pilotdeckDesktop = { platform, recordTaskReminder: record, setNotificationScope: async (scope: string | null) => { native.setScope(scope); } } as unknown as NonNullable<Window['pilotdeckDesktop']>;
  const { store, emit } = setup();
  emit({ type: 'session-activity-snapshot', scope: '1', activities: Array.from({ length: 25 }, (_, i) => ({ sessionId: `old-${i}`, completedRunId: `old-${i}` })) });
  expect(count).toBe(0);
  expect(record).not.toHaveBeenCalled();
  const completion = (id: string) => ({ ...event('s2', id), notification: { ...event('s2', id).notification, taskId: id, createdAt: new Date(Date.now() + 1).toISOString() } });
  emit(completion('r1'));
  emit(completion('r2'));
  expect(count).toBe(2);
  vi.advanceTimersByTime(2000);
  foreground = true;
  native.foreground();
  act(() => window.dispatchEvent(new Event('focus')));
  expect(count).toBe(0);
  expect(store.getSnapshot().unreadSessionIds.has('s2')).toBe(true);
  foreground = false;
  mocks.preferences.enabled = false;
  emit(completion('r3'));
  expect(count).toBe(1);
  expect(record).toHaveBeenCalledTimes(3);
});
