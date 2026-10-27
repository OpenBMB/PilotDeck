import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function load(name, require = () => { throw new Error('Unexpected dependency'); }) {
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const mod = {exports: {}};
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, require);
  return mod.exports;
}
const {installCompletionBadge, normalizeCompletionCount, completionBadgeBitmap} = load('completionBadge');

function desktop(platform, supported = true) {
  const counts = [], overlays = [], images = [], handlers = new Map();
  const app = new EventEmitter();
  let ready = true, destroyed = false, windowExists = true;
  app.isReady = () => ready;
  app.setBadgeCount = count => { counts.push(count); return supported; };
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.isDestroyed = () => destroyed;
  window.setOverlayIcon = (...args) => overlays.push(args);
  const owner = {};
  const badge = installCompletionBadge({platform, app, ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    nativeImage: {createFromBitmap: (bitmap, options) => { const image = {bitmap, options}; images.push(image); return image; }},
    getWindow: () => windowExists ? window : null,
    requireSender: event => { if (event !== owner) throw new Error('Untrusted sender'); },
  });
  badge.attachWindow(window);
  return {counts, overlays, images, app, window, owner,
    set: (count, event = owner) => handlers.get('pilotdeck:set-completion-badge')(event, count),
    destroy: () => { destroyed = true; window.emit('closed'); },
    removeWindow: () => { windowExists = false; },
    notReady: () => { ready = false; },
  };
}

test('badge counts reject invalid IPC values and cap large counts at 99', () => {
  for (const value of [undefined, null, {}, '3', -1, 0.5, NaN, Infinity, Number.MAX_VALUE]) {
    assert.equal(normalizeCompletionCount(value), 0);
  }
  for (const [input, expected] of [[0, 0], [1, 1], [99, 99], [100, 99], [10000, 99]]) {
    assert.equal(normalizeCompletionCount(input), expected);
  }
});

test('macOS and supported Linux launchers receive native counts including zero', () => {
  for (const platform of ['darwin', 'linux']) {
    const host = desktop(platform);
    host.set(1); host.set(2); host.set(999); host.set(0);
    assert.deepEqual(host.counts, [1, 2, 99, 0]);
    assert.equal(host.images.length, 0);
    assert.equal(host.overlays.length, 0);
  }
  assert.doesNotThrow(() => desktop('linux', false).set(2));
});

test('Windows creates a Retina overlay, reuses its bitmap and removes it at zero', () => {
  const host = desktop('win32');
  host.set(2); host.set(2); host.set(1000);
  assert.equal(host.images.length, 2);
  assert.deepEqual(host.images[0].options, {width: 32, height: 32, scaleFactor: 2});
  assert.match(host.overlays[0][1], /2 completed sessions/);
  assert.match(host.overlays[2][1], /99 completed sessions/);
  host.set(0);
  assert.deepEqual(host.overlays.at(-1), [null, '']);
  assert.equal(host.counts.length, 0);
});

test('numeric overlay bitmaps have transparent corners and distinct, visible white digits', () => {
  const bitmaps = new Set();
  for (let count = 1; count <= 99; count++) {
    const bitmap = completionBadgeBitmap(count);
    assert.equal(bitmap.length, 32 * 32 * 4);
    assert.equal(bitmap[3], 0);
    assert.equal(bitmap.at(-1), 0);
    let white = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      if (bitmap.subarray(i, i + 4).every(channel => channel === 255)) white++;
    }
    assert.ok(white >= 40, `readable digit pixels for ${count}`);
    bitmaps.add(bitmap.toString('base64'));
  }
  assert.equal(bitmaps.size, 99);
});

test('IPC rejects untrusted frames before changing any system icon', () => {
  for (const platform of ['win32', 'darwin']) {
    const host = desktop(platform);
    assert.throws(() => host.set(4, {}), /Untrusted sender/);
    assert.deepEqual(host.counts, []);
    assert.deepEqual(host.overlays, []);
  }
});

test('window hiding retains the badge; renderer replacement, crash and final quit clear it', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const host = desktop(platform);
    const last = () => platform === 'win32' ? host.overlays.at(-1)[0] : host.counts.at(-1);
    const assertCleared = () => assert.equal(last(), platform === 'win32' ? null : 0);
    host.set(3);
    host.window.emit('close', {preventDefault() {}});
    host.window.emit('hide');
    assert.ok(last());
    host.window.webContents.emit('did-start-navigation', {}, 'about:blank', true, true);
    assert.ok(last(), 'in-page navigation retains the badge');
    host.window.webContents.emit('did-start-navigation', {}, 'about:blank', false, false);
    assert.ok(last(), 'child-frame navigation retains the badge');
    host.window.webContents.emit('did-start-navigation', {}, 'about:blank', false, true);
    assertCleared();
    host.set(2);
    host.window.webContents.emit('render-process-gone');
    assertCleared();
    host.set(1);
    host.app.emit('will-quit');
    assertCleared();
    host.destroy();
    assertCleared();
  }
});

test('native updates are safe before app readiness and after the window is destroyed', () => {
  const mac = desktop('darwin');
  mac.notReady(); mac.set(3);
  assert.deepEqual(mac.counts, []);
  const win = desktop('win32');
  win.destroy(); win.set(3);
  win.removeWindow(); win.set(0);
  assert.deepEqual(win.overlays, []);
});

test('preload exposes only a count argument on the completion badge channel', async () => {
  const calls = [];
  let bridge;
  load('preload', name => {
    if (name === './preloadChrome') return {installWindowChrome() {}};
    if (name === 'electron') return {
      contextBridge: {exposeInMainWorld: (name, value) => { assert.equal(name, 'pilotdeckDesktop'); bridge = value; }},
      ipcRenderer: {invoke: async (...args) => { calls.push(args); }},
    };
    throw new Error(`Unexpected module ${name}`);
  });
  await bridge.setCompletionBadge(7);
  assert.deepEqual(calls, [['pilotdeck:set-completion-badge', 7]]);
});
