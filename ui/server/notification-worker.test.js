// @vitest-environment node
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { buildSystemNotification } from '../shared/notifications.js';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
// Only the IndexedDB request/transaction surface is faked. Execute the actual
// worker and retain structured-cloned storage when replacing its JS context.
function worker(database = {}, surfaces = { shown: [], forwarded: [], badge: 0, visible: false }) {
  const handlers = {};
  const client = { postMessage(message, ports) {
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
      addEventListener: (name, handler) => { handlers[name] = handler; },
      clients: { matchAll: async () => [client] },
      navigator: { setAppBadge: async count => { surfaces.badge = count; }, clearAppBadge: async () => { surfaces.badge = 0; } },
      registration: {
        showNotification: async (title, options) => {
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
    preferences: (scope = '1') => message('notification:preferences', { scope, preferences: { enabled: true } }),
    push: event => dispatch('push', { data: { json: () => ({ ...buildSystemNotification(event), event }) } }),
    read: (records, scope = '1') => message('notification:read', { scope, records }),
    pending: (scope = '1') => message('notification:pending', { scope }),
    restart: () => worker(database, surfaces),
  };
}
const event = (id, minute, scope = '1') => ({ id, sessionId: 's1', scope, kind: 'completed', createdAt: `2026-10-27T03:0${minute}:00Z` });
const record = event => ({ id: event.id, sessionId: event.sessionId, createdAt: event.createdAt });

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
