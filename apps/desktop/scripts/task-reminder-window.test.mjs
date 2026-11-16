import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/taskReminderWindow.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} }; new Function('module', 'exports', 'require', compiled)(mod, mod.exports, createRequire(import.meta.url));
const { createTaskReminderWindow, taskReminderHtml } = mod.exports;
const notification = { id: 'a'.repeat(64), title: 'Meeting', body: 'Scheduled reminder\nMeeting now', silent: false, persistent: true,
  data: { scope: '1', kind: 'reminder', sessionId: 'cron:task', taskId: 'task', eventId: 'a'.repeat(64), reminderId: 'a'.repeat(64), createdAt: '2026-11-16T12:00:00Z' } };

for (const platform of ['darwin', 'win32', 'linux']) test(`${platform}: keeps a secure, independent reminder window until acknowledged, including after restore`, async () => {
  const windows = [], views = [], dismissals = [];
  let beeps = 0;
  const options = {
    platform, preloadPath: '/synthetic/taskReminderPreload.js', workArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    palette: () => ({ background: '#fff' }), isQuitting: () => false,
    view: async data => { views.push(data); }, dismiss: id => dismissals.push(id), allowSound: () => true, beep: () => { beeps++; }, report: error => { throw error; },
    create(args) {
      const window = new EventEmitter(), contents = new EventEmitter();
      Object.assign(contents, { mainFrame: { url: '' }, send() {}, setWindowOpenHandler(handler) { this.open = handler; } });
      Object.assign(window, { args, webContents: contents, destroyed: false, isDestroyed() { return this.destroyed; },
        destroy() { this.destroyed = true; this.emit('closed'); }, async loadURL(url) { contents.mainFrame.url = url; },
        setVisibleOnAllWorkspaces(...args) { this.workspace = args; }, showInactive() { this.shown = true; }, setBounds() {} });
      windows.push(window); return window;
    },
  };
  let controller = createTaskReminderWindow(options);
  const snapshot = { scope: '1', language: 'en', reminders: [notification], soundId: notification.id };
  await controller.update(snapshot);
  const window = windows[0];
  assert.equal(window.shown, true); assert.equal(window.args.alwaysOnTop, true); assert.equal(window.args.parent, undefined);
  assert.equal(window.args.webPreferences.sandbox, true); assert.equal(window.args.webPreferences.nodeIntegration, false);
  assert.equal(window.args.webPreferences.contextIsolation, true); assert.deepEqual(window.webContents.open(), { action: 'deny' });
  assert.equal(Boolean(window.workspace), platform !== 'win32');
  const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.equal(controller.handle(sender, { action: 'view', id: notification.id }), true);
  assert.deepEqual(views, [notification.data]); assert.equal(window.destroyed, false); assert.equal(dismissals.length, 0);
  assert.equal(controller.handle({ ...sender, sender: {} }, { action: 'dismiss', id: notification.id }), false);
  controller.handle(sender, { action: 'dismiss', id: notification.id });
  assert.deepEqual(dismissals, [notification.id]); assert.equal(window.destroyed, false, 'wait for durable acknowledgement');
  await controller.update(snapshot); assert.equal(beeps, 1);
  controller.dispose(); controller = createTaskReminderWindow(options);
  await controller.update({ ...snapshot, soundId: undefined });
  assert.equal(windows[1].shown, true); assert.equal(beeps, 1, 'restoring pending reminders must be silent');
  await controller.update({ ...snapshot, reminders: [] }); assert.equal(windows[1].destroyed, true);
});

test('reminder renderer uses a nonce CSP, plain text, and an isolated action-only bridge', () => {
  const html = taskReminderHtml('synthetic-nonce');
  assert.ok(html.includes("default-src 'none'")); assert.ok(html.includes("script-src 'nonce-synthetic-nonce'"));
  assert.ok(html.includes('textContent=item.title')); assert.ok(!html.includes('innerHTML'));
  const preload = fs.readFileSync(new URL('../src/taskReminderPreload.ts', import.meta.url), 'utf8');
  assert.ok(!preload.includes('pilotdeckDesktop')); assert.ok(!preload.includes('invoke('));
});
