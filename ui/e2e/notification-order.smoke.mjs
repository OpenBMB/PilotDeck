// Standalone regression: node ui/e2e/notification-order.smoke.mjs
// Uses an isolated Chrome profile and real Service Worker/IndexedDB. Only OS
// notifications and badge surfaces are captured, so the user's desktop is quiet.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { buildSystemNotification } from '../shared/notifications.js';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const captureSurfaces = `
  self.__shown = [];
  self.__badge = 0;
  self.navigator.setAppBadge = async count => { self.__badge = count; };
  self.navigator.clearAppBadge = async () => { self.__badge = 0; };
  self.registration.showNotification = async (title, options) => {
    const card = { title, ...options, closed: false };
    card.close = () => { card.closed = true; };
    self.__shown.push(card);
  };
  self.registration.getNotifications = async () => self.__shown.filter(card => !card.closed);
`;
const server = http.createServer((request, response) => {
  const sw = request.url === '/sw.js';
  response.setHeader('Content-Type', sw ? 'application/javascript' : request.url === '/manifest.json' ? 'application/json' : 'text/html');
  response.setHeader('Cache-Control', 'no-store');
  response.end(sw ? source + captureSurfaces : request.url === '/manifest.json' ? '{}' : '<!doctype html><title>Notification regression</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'pilotdeck-push-order-'));
let context;
async function launch() {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, permissions: ['notifications'] });
  const page = context.pages()[0];
  await page.goto(origin);
  await page.evaluate(async () => {
    window.__received = [];
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'notification:context') event.ports[0].postMessage({ viewed: window.__viewed === true });
      else if (event.data?.type === 'notification:received') window.__received.push(event.data.notification.id);
    });
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    window.__workerMessage = async (type, value) => {
      const registration = await navigator.serviceWorker.ready;
      return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
        registration.active.postMessage({ type, value }, [channel.port2]);
      });
    };
  });
  const worker = context.serviceWorkers()[0];
  assert.ok(worker);
  const message = (type, value) => page.evaluate(([type, value]) => window.__workerMessage(type, value), [type, value]);
  const read = event => message('notification:read', { scope: '1', records: [{ sessionId: event.sessionId, id: event.id, createdAt: event.createdAt }] });
  const push = event => worker.evaluate(async payload => {
    const pending = [];
    const push = new Event('push');
    push.data = { json: () => payload };
    push.waitUntil = promise => pending.push(promise);
    self.dispatchEvent(push);
    await Promise.all(pending);
  }, { ...buildSystemNotification(event), event });
  const snapshot = () => worker.evaluate(async () => ({
    badge: self.__badge, shown: self.__shown.length, active: self.__shown.filter(card => !card.closed).length,
    pending: await notificationState(state => Object.values(state.pending).map(record => record.id)),
  }));
  return { page, worker, message, read, push, snapshot };
}
const event = minute => ({ id: `r${minute}`, sessionId: 's1', scope: '1', kind: 'completed', createdAt: `2026-10-27T03:0${minute}:00Z` });
try {
  let w = await launch();
  await w.message('notification:preferences', { scope: '1', preferences: { enabled: true } });
  await w.push(event(2));
  assert.equal((await w.snapshot()).badge, 0);
  await w.read(event(2));
  assert.equal((await w.snapshot()).badge, 0);
  await w.push(event(1));
  assert.deepEqual(await w.snapshot(), { badge: 0, shown: 1, active: 0, pending: [] });
  await w.push(event(4));
  await w.push(event(3));
  assert.deepEqual(await w.snapshot(), { badge: 0, shown: 2, active: 1, pending: ['r4'] });
  await w.read(event(2));
  assert.equal((await w.snapshot()).badge, 0);
  await w.read(event(5)); // A newer live-page read also clears an older push card.
  assert.deepEqual(await w.snapshot(), { badge: 0, shown: 2, active: 0, pending: [] });
  assert.deepEqual(await w.page.evaluate(() => window.__received), ['r2', 'r4']);
  await context.close();
  w = await launch(); // Fresh worker execution, same on-disk IndexedDB.
  await w.push(event(3));
  assert.deepEqual(await w.snapshot(), { badge: 0, shown: 0, active: 0, pending: [] });
  await w.push(event(6));
  assert.equal((await w.snapshot()).badge, 0);
  await w.page.evaluate(() => { window.__viewed = true; });
  await w.push(event(7));
  assert.deepEqual(await w.snapshot(), { badge: 0, shown: 1, active: 0, pending: [] });
  console.log('PASS: real Chrome SW/IndexedDB rejects delayed pushes, preserves newer pending events, closes older cards, and retains read progress across browser restarts.');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
