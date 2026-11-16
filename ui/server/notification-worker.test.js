// @vitest-environment node
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { buildSystemNotification, buildTaskReminderNotification } from '../shared/notifications.js';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
// Only the IndexedDB request/transaction surface is faked. Execute the actual
// worker and retain structured-cloned storage when replacing its JS context.
function worker(database = {}, surfaces = { shown: [], forwarded: [], badge: 0, visible: false }) {
  const handlers = {};
  const client = { url: 'https://pilotdeck.example.test/', focus: async () => {}, postMessage(message, ports) {
    if (message.type === 'notification:context') ports[0].postMessage({ viewed: surfaces.visible });
    else surfaces.forwarded.push(message);
  } };
  const context = vm.createContext({
    setTimeout, clearTimeout,
    MessageChannel: class {
      port1 = { close() {} };
      port2 = { postMessage: data => this.port1.onmessage({ data }) };
    },
    indexedDB: { open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          close() {}, createObjectStore() {},
          transaction() {
            const tx = { objectStore: () => ({
              get() {
                const read = {};
                queueMicrotask(() => {
                  read.result = structuredClone(database.value);
                  read.onsuccess();
                  queueMicrotask(() => tx.oncomplete());
                });
                return read;
              },
              put: value => { database.value = structuredClone(value); },
            }) };
            return tx;
          },
        };
        if (!database.value) request.onupgradeneeded();
        request.onsuccess();
      });
      return request;
    } },
    self: {
      location: { origin: 'https://pilotdeck.example.test' },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      clients: { matchAll: async () => surfaces.noClients ? [] : [client] },
      navigator: { setAppBadge: async count => { surfaces.badge = count; }, clearAppBadge: async () => { surfaces.badge = 0; } },
      registration: {
        showNotification: async (title, options) => {
          if (surfaces.fail) throw new Error('Synthetic notification rejection');
          const item = { title, ...options, closed: false };
          item.close = vi.fn(() => { item.closed = true; });
          surfaces.shown.push(item);
        },
        getNotifications: async () => surfaces.shown.filter(item => !item.closed),
      },
    },
  });
  vm.runInContext(source, context);
  async function dispatch(type, event) {
    let done;
    handlers[type]({ ...event, waitUntil: promise => { done = promise; } });
    await done;
  }
  const message = async (type, value) => {
    let result;
    await dispatch('message', { data: { type, value }, ports: [{ postMessage: value => { result = value; } }] });
    return result;
  };
  return {
    surfaces, database, message,
    click: notification => dispatch('notificationclick', { notification }),
    dismiss: notification => dispatch('notificationclose', { notification }),
    preferences: (scope = '1') => message('notification:preferences', { scope, preferences: { enabled: true } }),
    push: event => dispatch('push', { data: { json: () => ({ ...buildSystemNotification(event), event }) } }),
    read: (records, scope = '1') => message('notification:read', { scope, records }),
    pending: (scope = '1') => message('notification:pending', { scope }),
    restart: () => worker(database, surfaces),
  };
}
const event = (id, minute, scope = '1') => ({ id, sessionId: 's1', scope, kind: 'completed', createdAt: `2026-10-27T03:0${minute}:00Z` });
const record = event => ({ id: event.id, sessionId: event.sessionId, createdAt: event.createdAt });

it('keeps scheduled reminders visible after viewing the conversation and deduplicates across worker restarts', async () => {
  let w = worker(); await w.preferences(); w.surfaces.visible = true;
  const reminder = { id: 'a'.repeat(64), title: 'Meeting', body: 'Meeting now', kind: 'due', taskId: 'task',
    sessionKey: 'cron:task', createdAt: '2026-10-27T03:01:00Z' };
  const payload = buildTaskReminderNotification(reminder, { enabled: true }, 'en', '1');
  await w.message('notification:show', payload);
  expect(w.surfaces.shown).toHaveLength(1);
  expect(w.surfaces.shown[0].requireInteraction).toBe(true);
  await w.read([{ sessionId: 'cron:task', id: reminder.id, createdAt: reminder.createdAt }]);
  expect(w.surfaces.shown[0].closed).toBe(false);
  w = w.restart(); await w.message('notification:show', payload);
  expect(w.surfaces.shown).toHaveLength(1);
  await w.message('notification:task-dismiss', { scope: '1', id: reminder.id });
  expect(w.surfaces.shown[0].closed).toBe(true);
  await w.restart().message('notification:show', payload);
  expect(w.surfaces.shown).toHaveLength(1);
});

it('clears a legacy PWA badge while preserving pending conversation unread records', async () => {
  const surfaces = { shown: [], forwarded: [], badge: 25, visible: false };
  const pending = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`old-${i}`, { ...record(event('old', 1)), sessionId: `old-${i}` }]));
  const w = worker({ value: { seen: [], pending, scope: '1', preferences: { enabled: true }, lastSound: 0 } }, surfaces);
  await w.preferences();
  expect(surfaces.badge).toBe(0);
  expect(await w.pending()).toHaveLength(25);
  expect(surfaces.shown).toHaveLength(0);
  await w.push(event('fresh', 3));
  expect(surfaces.badge).toBe(0);
  expect(surfaces.shown).toHaveLength(1);
});

it('keeps an already-read conversation clear when an older push arrives after a worker restart', async () => {
  let w = worker();
  await w.preferences();
  const newer = event('r2', 2);
  await w.push(newer);
  expect(w.surfaces.badge).toBe(0);
  await w.read([record(newer)]);
  expect(w.surfaces.badge).toBe(0);
  expect(w.surfaces.shown[0].close).toHaveBeenCalledOnce();
  w = w.restart();
  await w.push(event('r1', 1));
  expect(w.surfaces.badge).toBe(0);
  expect(await w.pending()).toEqual([]);
  expect(w.surfaces.shown).toHaveLength(1);
  expect(w.surfaces.forwarded).toHaveLength(1);
  await w.push(event('r3', 3));
  expect(w.surfaces.badge).toBe(0);
  expect(w.surfaces.shown).toHaveLength(2);
});
it('preserves newer pending events and lets newer read progress clear an older, different event ID', async () => {
  const w = worker();
  await w.preferences();
  await w.push(event('r2', 2));
  await w.push(event('r1', 1));
  expect(await w.pending()).toEqual([record(event('r2', 2))]);
  expect(w.surfaces.shown).toHaveLength(1);
  await w.read([record(event('r3', 3))]);
  expect(w.surfaces.badge).toBe(0);
  expect(w.surfaces.shown[0].closed).toBe(true);
  await w.read([record(event('r1', 1))]);
  await w.push(event('unseen-old', 2));
  expect(await w.pending()).toEqual([]);
  expect(w.surfaces.shown).toHaveLength(1);
});
it('does not let a late read acknowledgement clear a newer pending event', async () => {
  const w = worker();
  await w.preferences();
  await w.read([record(event('r2', 2))]);
  await w.push(event('r3', 3));
  await w.read([record(event('r1', 1))]);
  expect(await w.pending()).toEqual([record(event('r3', 3))]);
  expect(w.surfaces.badge).toBe(0);
  expect(w.surfaces.shown[0].closed).toBe(false);
});
it('persists foreground read progress without showing a notification', async () => {
  const w = worker();
  await w.preferences();
  w.surfaces.visible = true;
  await w.push(event('r2', 2));
  w.surfaces.visible = false;
  await w.restart().push(event('r1', 1));
  expect(w.surfaces.shown).toHaveLength(0);
  expect(w.surfaces.badge).toBe(0);
  expect(await w.pending()).toEqual([]);
});
it.each([undefined, 'invalid', '2026-10-27T03:02:00Z'])('does not promote an undated, invalid or tied old event (%s)', async createdAt => {
  const w = worker();
  await w.preferences();
  await w.read([record(event('r2', 2))]);
  await w.push({ ...event('unknown', 1), createdAt });
  expect(w.surfaces.shown).toHaveLength(0);
  expect(w.surfaces.badge).toBe(0);
});
it('isolates progress and read acknowledgements between accounts', async () => {
  const w = worker();
  await w.preferences();
  await w.read([record(event('r2', 2))]);
  await w.preferences('2');
  await w.push(event('r1', 1, '2'));
  await w.push(event('old-account', 3));
  await w.read([record(event('r3', 3))]);
  expect(await w.pending('2')).toEqual([record(event('r1', 1, '2'))]);
  expect(w.surfaces.shown).toHaveLength(1);
});
it('upgrades existing storage and recovers timestamps from legacy ID-only read acknowledgements', async () => {
  const w = worker({ value: { seen: [], pending: { s1: record(event('r2', 2)) }, scope: '1', preferences: { enabled: true }, lastSound: 0 } });
  await w.read([{ sessionId: 's1', id: 'r2' }]);
  await w.restart().push(event('r1', 1));
  expect(w.surfaces.shown).toHaveLength(0);
  expect(w.surfaces.badge).toBe(0);
  expect(await w.pending()).toEqual([]);
});
it('enriches an ID-only watermark when a current page supplies its timestamp', async () => {
  const w = worker();
  await w.preferences();
  await w.read([{ sessionId: 's1', id: 'r2' }]);
  await w.read([record(event('r2', 2))]);
  await w.push(event('r1', 1));
  expect(w.surfaces.shown).toHaveLength(0);
});

it('does not consume denied or failed reminder delivery and keeps receipts beyond normal chat cache eviction', async () => {
  let w = worker(); await w.preferences();
  const payload = buildTaskReminderNotification({ id: 'b'.repeat(64), title: 'Meeting', kind: 'due', taskId: 'task', sessionKey: 'cron:task' }, {}, 'en', '1');
  await w.message('notification:preferences', { scope: '1', preferences: { enabled: false } });
  expect(await w.message('notification:show', payload)).toBe(false);
  await w.preferences(); w.surfaces.fail = true;
  expect(await w.message('notification:show', payload)).toBe(false);
  w.surfaces.fail = false; expect(await w.message('notification:show', payload)).toBe(true);
  w.database.value.seen = []; w = w.restart();
  expect(await w.message('notification:show', payload)).toBe(true); expect(w.surfaces.shown).toHaveLength(1);
});
it('routes system activation to the task without acknowledging, and forwards explicit user dismissal separately', async () => {
  const w = worker(); await w.preferences();
  const payload = buildTaskReminderNotification({ id: 'c'.repeat(64), title: 'Meeting', kind: 'due', taskId: 'task-a', sessionKey: 'cron:task-a' }, {}, 'en', '1');
  await w.message('notification:show', payload); const notification = w.surfaces.shown[0];
  await w.click(notification);
  expect(notification.close).not.toHaveBeenCalled();
  expect(w.surfaces.forwarded.at(-1)).toMatchObject({ type: 'notification:navigate', kind: 'reminder', taskId: 'task-a', urlPath: '/cron?taskId=task-a' });
  expect(w.surfaces.forwarded.some(item => item.type === 'notification:task-dismissed')).toBe(false);
  await w.dismiss(notification);
  expect(w.surfaces.forwarded.at(-1)).toEqual({ type: 'notification:task-dismissed', scope: '1', id: payload.id });
  await w.restart().message('notification:show', payload); expect(w.surfaces.shown).toHaveLength(1);
});

it('retains offline dismissals across worker restart until the page confirms server acknowledgement', async () => {
  let w = worker(); await w.preferences();
  const payload = buildTaskReminderNotification({ id: 'd'.repeat(64), title: 'Meeting', kind: 'due', taskId: 'task', sessionKey: 'cron:task' }, {}, 'en', '1');
  await w.message('notification:show', payload);
  w.surfaces.noClients = true;
  await w.dismiss(w.surfaces.shown[0]);
  w = w.restart();
  const dismissal = { scope: '1', id: payload.id };
  expect(await w.message('notification:task-pending-dismissals', { scope: '1' })).toEqual([dismissal]);
  expect(await w.message('notification:task-pending-dismissals', { scope: '2' })).toEqual([]);
  expect(await w.message('notification:show', payload)).toBe(true);
  expect(w.surfaces.shown).toHaveLength(1);
  await w.message('notification:task-acknowledged', dismissal);
  w = w.restart();
  expect(await w.message('notification:task-pending-dismissals', { scope: '1' })).toEqual([]);
});
