import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(async () => {}), subscriptions: vi.fn(), remove: vi.fn() }));
vi.mock('web-push', () => ({ default: { sendNotification: mocks.send } }));
vi.mock('../database/db.js', () => ({
  notificationPreferencesDb: {}, sessionNamesDb: { getName: () => 'Named conversation' },
  pushSubscriptionsDb: { getSubscriptions: mocks.subscriptions, removeSubscription: mocks.remove },
}));
import { notifySessionAttention } from './notification-orchestrator.js';
afterEach(() => { vi.clearAllMocks(); });
const event = { id: 'r1', sessionId: 's1', scope: '7', kind: 'completed', preview: 'Private answer', createdAt: '2026-10-27T03:00:00Z' };
it('honors each device language, sound and privacy preferences before contacting the push service', () => {
  mocks.subscriptions.mockReturnValue([
    { endpoint: 'first', keys_p256dh: 'p', keys_auth: 'a', preferences_json: JSON.stringify({ enabled: true, sound: false, preview: false, language: 'zh-CN' }) },
    { endpoint: 'second', keys_p256dh: 'p', keys_auth: 'a', preferences_json: JSON.stringify({ enabled: true, language: 'en' }) },
    { endpoint: 'disabled', preferences_json: JSON.stringify({ enabled: false }) },
  ]);
  notifySessionAttention(7, event);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  const first = JSON.parse(mocks.send.mock.calls[0][1]);
  expect(first).toMatchObject({ title: 'Named conversation', silent: true });
  expect(first.body).toContain('任务已完成');
  expect(JSON.stringify(first)).not.toContain('Private answer');
  expect(JSON.parse(mocks.send.mock.calls[1][1]).body).toContain('Private answer');
});
it('removes only the expired subscription belonging to the notified user', async () => {
  mocks.subscriptions.mockReturnValue([{ endpoint: 'expired', preferences_json: '{}' }]);
  mocks.send.mockRejectedValueOnce({ statusCode: 410 });
  notifySessionAttention(7, event);
  await Promise.resolve();
  expect(mocks.remove).toHaveBeenCalledWith('expired', 7);
});
