import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/notifications.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', compiled)(mod, mod.exports, createRequire(import.meta.url));
const { createDesktopNotifications, badgeBitmap, nativeNotificationOptions, normalizePreferences } = mod.exports;
test('desktop notifications default on while preserving an explicit opt-out', () => {
  assert.equal(normalizePreferences(undefined).enabled, true);
  assert.equal(normalizePreferences({}).enabled, true);
  assert.equal(normalizePreferences({ enabled: false }).enabled, false);
});
const payload = { id: 'r1', title: 'Report', body: 'Task completed · Click to view\nPreview', silent: false, data: { scope: '1', sessionId: 's1', eventId: 'r1', taskId: 'r1', createdAt: '2026-10-28T00:00:01Z', kind: 'completed' } };
function setup(platform = 'darwin', bind = true, saved = { receipts: [] }) {
  const state = { created: [], badges: [], overlays: [], navigation: [], dismissed: [], errors: [], saved: null, foreground: false, now: Date.parse('2026-10-28T00:00:00Z'), tray: [] };
  const controller = createDesktopNotifications({
    platform, isForeground: () => state.foreground, now: () => state.now, supported: () => true, read: () => ({ enabled: true }), save: value => { state.saved = value; },
    reminderReceipts: { read: () => saved.receipts, write: value => { saved.receipts = structuredClone(value); } },
    dismissReminder: data => state.dismissed.push(data), showTimeoutMs: 100,
    create: value => { const item = Object.assign(new EventEmitter(), { payload: value, shown: false, show() { this.shown = true; if (this.payload.data.kind === 'reminder') queueMicrotask(() => this.emit('show')); }, close() { this.emit('close'); } }); state.created.push(item); return item; },
    setTrayBadge: count => state.tray.push(count), setBadge: count => state.badges.push(count), setOverlay: (bitmap, label) => state.overlays.push({ bitmap, label }),
    navigate: async data => { state.navigation.push(data); }, report: error => { state.errors.push(error); },
  });
  if (bind) controller.setScope('1');
  return { controller, state };
}
test('deduplicates native notifications and restores the exact conversation on click', async () => {
  const { controller, state } = setup();
  assert.equal(controller.show(payload), true);
  assert.equal(controller.show(payload), false);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].shown, true);
  state.created[0].emit('click');
  assert.deepEqual(state.navigation, [payload.data]);
  controller.show({ ...payload, id: 'r2' });
  assert.equal(state.created[1].payload.silent, true, 'nearby tasks must not stack sounds');
});
for (const platform of ['darwin', 'win32', 'linux']) test(`${platform}: hides zero badges and applies the independent badge preference`, () => {
  const { controller, state } = setup(platform);
  for (let i = 0; i < 5; i++) controller.record({ ...payload, id: `r${i}`, data: { ...payload.data, taskId: `r${i}` } });
  controller.preferences({ enabled: false, badge: false });
  assert.equal(controller.show(payload), false);
  if (platform === 'win32') {
    assert.ok(state.overlays.every(overlay => overlay.bitmap === null));
    assert.equal(state.overlays.at(-1).bitmap, null);
  } else assert.equal(state.badges.at(-2), 5);
  assert.equal(state.tray.at(-1), 0);
});
test('supports silent notifications and enforces preview privacy in the main process', () => {
  const { controller, state } = setup();
  controller.preferences({ enabled: true, sound: false, preview: false });
  controller.show(payload);
  assert.equal(state.created[0].payload.silent, true);
  assert.equal(state.created[0].payload.body.includes('Preview'), false);
  assert.equal(controller.status().permission, 'unknown', 'support must not be presented as OS permission');
  assert.throws(() => controller.show({ ...payload, data: { sessionId: '' } }), /Invalid notification/);
  assert.equal(badgeBitmap(123).length, 4096);
});

for (const platform of ['darwin', 'win32', 'linux']) test(`${platform}: relies on OS application identity without an extra notification image`, () => {
  const options = nativeNotificationOptions(platform, payload);
  assert.equal(options.title, payload.title);
  assert.equal(options.body, payload.body);
  assert.equal('icon' in options, false);
  assert.equal('toastXml' in options, false, 'the default Windows template must not add another image');
  assert.equal(options.silent, payload.silent);
  assert.equal(options.urgency, platform === 'linux' ? 'normal' : undefined);
});

for (const platform of ['darwin', 'win32', 'linux']) test(`${platform}: counts background tasks, resets on foreground, and rejects pre-focus replays`, () => {
  const { controller, state } = setup(platform);
  const count = () => state.tray.at(-1);
  const event = (id, taskId = id, createdAt = payload.data.createdAt) => ({ ...payload, id, data: { ...payload.data, taskId, createdAt } });
  assert.equal(count(), 0, 'startup does not restore conversation unread counts');
  controller.record(event('approval:r1', 'r1'));
  controller.record(event('question:r1', 'r1'));
  controller.show(event('r1'));
  assert.equal(count(), 1, 'approval, question and completion of one task occupy one badge slot');
  controller.record(event('r2'));
  assert.equal(count(), 2, 'two tasks in the same conversation count separately');
  controller.record(event('r2'));
  assert.equal(count(), 2, 'replayed events do not increment');
  state.foreground = true;
  state.now += 2000;
  controller.foreground();
  assert.equal(count(), 0);
  controller.record(event('foreground-task', 'foreground-task', new Date(state.now).toISOString()));
  assert.equal(count(), 0, 'no increment while the native window has focus');
  state.foreground = false;
  controller.record(event('late-old-task'));
  controller.record(event('foreground-task', 'foreground-task', new Date(state.now).toISOString()));
  assert.equal(count(), 0, 'pre-focus and foreground events cannot reappear after going back to background');
  controller.record(event('new-question', 'r1', new Date(state.now + 1).toISOString()));
  assert.equal(count(), 1, 'a task can remind again during a new background period');
  assert.equal(controller.record({ ...event('unknown-time'), data: { ...payload.data, createdAt: undefined } }), false);
  assert.equal(controller.record(event('invalid-time', 'invalid', 'invalid')), false);
});

test('badge recording is independent of banners, native notification support and account read history', () => {
  const { controller, state } = setup();
  controller.preferences({ enabled: false, badge: true });
  controller.record(payload);
  assert.equal(state.tray.at(-1), 1);
  assert.equal(controller.show(payload), false);
  assert.equal(state.created.length, 0);
  controller.preferences({ enabled: false, badge: false });
  assert.equal(state.tray.at(-1), 0);
  controller.preferences({ enabled: false, badge: true });
  assert.equal(state.tray.at(-1), 1);
  controller.setScope('2');
  assert.equal(state.tray.at(-1), 0);
  assert.equal(controller.record({ ...payload, id: 'old-account' }), false);
  controller.record({ ...payload, data: { ...payload.data, scope: '2' } });
  assert.equal(state.tray.at(-1), 1);
  controller.setScope('2');
  assert.equal(state.tray.at(-1), 1, 'a renderer reconnect cannot reset an unchanged account');
  const restarted = setup().controller;
  restarted.setScope('1');
  assert.equal(restarted.record({ ...payload, data: { ...payload.data, createdAt: '2026-10-27T00:00:00Z' } }), false);
});
test('first server scope binding keeps the startup baseline across IPC latency', () => {
  const { controller, state } = setup('darwin', false);
  state.now += 2000;
  controller.setScope('1');
  assert.equal(controller.record(payload), true, 'an event created after startup but before first scope delivery is new');
  assert.equal(state.tray.at(-1), 1);
});

const reminder = { ...payload, id: 'a'.repeat(64), persistent: true, data: { ...payload.data, kind: 'reminder', reminderId: 'a'.repeat(64), taskId: 'task-a', sessionId: 'cron:task-a', eventId: 'a'.repeat(64), createdAt: '2026-10-01T00:00:00Z' } };
for (const platform of ['darwin', 'win32', 'linux']) test(`${platform}: scheduled reminders use the OS channel, recover once, and retain independent occurrences`, async () => {
  const saved = { receipts: [] }; let { controller, state } = setup(platform, true, saved);
  state.foreground = true; controller.foreground();
  assert.equal(await controller.show(reminder), true, 'scheduled recovery bypasses the ordinary focus/time baseline');
  assert.equal(await controller.show(reminder), true); assert.equal(state.created.length, 1);
  const options = nativeNotificationOptions(platform, reminder);
  assert.equal(options.timeoutType, platform === 'darwin' ? undefined : 'never');
  assert.ok(options.id); assert.equal('icon' in options, false);
  state.created[0].emit('click');
  assert.deepEqual(state.navigation, [reminder.data]);
  assert.deepEqual(state.dismissed, [], 'viewing must not acknowledge a reminder');
  const second = { ...reminder, id: 'b'.repeat(64), data: { ...reminder.data, reminderId: 'b'.repeat(64) } };
  await controller.show(second);
  assert.equal(state.created[0].shown, true); assert.equal(state.created.length, 2);
  controller = setup(platform, true, saved).controller;
  assert.equal(await controller.show(reminder), true, 'persisted OS receipt prevents a duplicate after process restart');
});
test('does not consume a failed or disabled scheduled notification and distinguishes timeout from explicit dismissal', async () => {
  const { controller, state } = setup('win32');
  controller.preferences({ enabled: false }); assert.equal(await controller.show(reminder), false);
  assert.equal(state.created.length, 0); controller.preferences({ enabled: true });
  await controller.show(reminder);
  state.created[0].emit('close', { reason: 'timedOut' }); assert.deepEqual(state.dismissed, []);
  const second = { ...reminder, id: 'b'.repeat(64), data: { ...reminder.data, reminderId: 'b'.repeat(64) } };
  await controller.show(second); state.created[1].emit('close', { reason: 'userCanceled' });
  assert.deepEqual(state.dismissed, [{ scope: '1', id: second.id }]);
  const third = { ...reminder, id: 'c'.repeat(64), data: { ...reminder.data, reminderId: 'c'.repeat(64) } };
  const attempt = controller.show(third); await Promise.resolve();
  state.created[2].emit('failed', {}, 'synthetic unavailable');
  assert.equal(await attempt, false);
  assert.equal(await controller.show(third), true);
  assert.equal(state.created.length, 4, 'a failed native delivery is retryable');
});
test('restores native history navigation without redisplaying, and routes only recognized Windows activation IDs', async () => {
  const saved = { receipts: [] }; const initial = setup('darwin', true, saved);
  await initial.controller.show(reminder);
  const nativeId = saved.receipts[0].id;
  const historyItem = Object.assign(new EventEmitter(), { id: nativeId, show() { throw Error('restoring history must not redisplay'); }, close() {} });
  const navigation = [], removed = [];
  const restored = createDesktopNotifications({ platform: 'darwin', read: () => ({}), save() {}, supported: () => true,
    isForeground: () => true, create() { throw Error('no new notification on restore'); }, setBadge() {}, setOverlay() {},
    reminderReceipts: { read: () => saved.receipts, write() {} }, restore: async () => [historyItem], removeReminder: id => removed.push(id),
    navigate: async data => navigation.push(data), report: error => { throw error; } });
  restored.setScope('1'); await restored.restoreReminders(); historyItem.emit('click');
  assert.deepEqual(navigation, [reminder.data]);
  restored.dismissReminder({ scope: '1', id: reminder.id }); assert.deepEqual(removed, [nativeId]);
  assert.equal(restored.activateReminder('arbitrary'), false);
  assert.equal(restored.activateReminder('pdReminder=' + nativeId), true);
  restored.setScope('other-account'); assert.equal(restored.activateReminder('pdReminder=' + nativeId), false);
  const toast = nativeNotificationOptions('win32', { ...reminder, title: 'A & B "meeting"' });
  assert.match(toast.toastXml, /scenario="reminder"/); assert.match(toast.toastXml, /A &amp; B &quot;meeting&quot;/);
  assert.match(toast.toastXml, /pdReminder=[a-f0-9]{32}/); assert.ok(!toast.toastXml.includes('cron:'));
});

test('macOS recovers pending notifications removed on app exit without resurrecting explicitly dismissed ones', async () => {
  const saved = { receipts: [] }; const initial = setup('darwin', true, saved);
  await initial.controller.show(reminder);
  let attempts = 0;
  const options = { platform: 'darwin', read: () => ({}), save() {}, supported: () => true, isForeground: () => true,
    setBadge() {}, setOverlay() {}, showTimeoutMs: 100,
    create() { attempts++; const item = new EventEmitter(); Object.assign(item, { show() { queueMicrotask(() => item.emit('show')); }, close() {} }); return item; },
    reminderReceipts: { read: () => saved.receipts, write: receipts => { saved.receipts = structuredClone(receipts); } },
    restore: async () => [], navigate: async () => {}, report: error => { throw error; } };
  const restarted = createDesktopNotifications(options); await restarted.restoreReminders(); restarted.setScope('1');
  assert.equal(await restarted.show(reminder), true); assert.equal(attempts, 1, 'a pending server record can restore a missing system notification');
  assert.equal(await restarted.show(reminder), true); assert.equal(attempts, 1);
  restarted.dismissReminder({ scope: '1', id: reminder.id });
  const afterDismiss = createDesktopNotifications(options); await afterDismiss.restoreReminders(); afterDismiss.setScope('1');
  assert.equal(await afterDismiss.show(reminder), true); assert.equal(attempts, 1, 'confirmed close is durable even when the server acknowledgement was unavailable');
});

test('Windows View task activation is not mistaken for an explicit close', async () => {
  const { controller, state } = setup('win32'); await controller.show(reminder);
  const id = nativeNotificationOptions('win32', reminder).id;
  assert.equal(controller.activateReminder('pdReminder=' + id), true);
  state.created[0].emit('close', { reason: 'userCanceled' });
  assert.deepEqual(state.navigation, [reminder.data]); assert.deepEqual(state.dismissed, []);
});
