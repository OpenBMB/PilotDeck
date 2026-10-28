import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/notifications.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', compiled)(mod, mod.exports);
const { createDesktopNotifications, badgeBitmap, nativeNotificationOptions, normalizePreferences } = mod.exports;
test('desktop notifications default on while preserving an explicit opt-out', () => {
  assert.equal(normalizePreferences(undefined).enabled, true);
  assert.equal(normalizePreferences({}).enabled, true);
  assert.equal(normalizePreferences({ enabled: false }).enabled, false);
});
const payload = { id: 'r1', title: 'Report', body: 'Task completed · Click to view\nPreview', silent: false, data: { scope: '1', sessionId: 's1', eventId: 'r1', taskId: 'r1', createdAt: '2026-10-28T00:00:01Z', kind: 'completed' } };
function setup(platform = 'darwin', bind = true) {
  const state = { created: [], badges: [], overlays: [], navigation: [], saved: null, foreground: false, now: Date.parse('2026-10-28T00:00:00Z'), tray: [] };
  const controller = createDesktopNotifications({
    platform, isForeground: () => state.foreground, now: () => state.now, supported: () => true, read: () => ({ enabled: true }), save: value => { state.saved = value; },
    create: value => { const item = Object.assign(new EventEmitter(), { payload: value, shown: false, show() { this.shown = true; }, close() { this.emit('close'); } }); state.created.push(item); return item; },
    setTrayBadge: count => state.tray.push(count), setBadge: count => state.badges.push(count), setOverlay: (bitmap, label) => state.overlays.push({ bitmap, label }),
    navigate: async data => { state.navigation.push(data); }, report: error => { throw error; },
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
