import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(name) {
  const source = fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, id => id.startsWith('./') ? load(id.slice(2)) : require(id));
  return mod.exports;
}
const { createDesktopTray } = load('desktopTray');
const { createDesktopLifecycle } = load('desktopLifecycle');
const { buildApplicationMenu } = load('applicationMenu');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ failTray = false, platform = 'win32', stopRuntime = async () => {} } = {}) {
  const state = { quitting: false, chinese: true, quits: 0, restores: 0, dialogs: [], errors: [] };
  const window = Object.assign(new EventEmitter(), {
    isFullScreen: () => false, visible: true, destroyed: false, hide() { this.visible = false; }, isDestroyed() { return this.destroyed; },
  });
  const tray = Object.assign(new EventEmitter(), {
    destroyed: false, menu: [], isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; },
    setToolTip(text) { this.tooltip = text; }, setContextMenu(menu) { this.menu = menu; },
  });
  let trayController;
  const lifecycle = createDesktopLifecycle({
    platform,
    shouldConfirm: () => true,
    canHide: () => platform === 'darwin' || trayController.available(),
    getWindow: () => window,
    restoreWindow: async () => { state.restores++; window.visible = true; },
    isQuitting: () => state.quitting, setQuitting: value => { state.quitting = value; trayController?.setQuitting(value); },
    hideWindow: () => { window.hide(); },
    isChinese: () => state.chinese,
    showDialog: (owner, options) => new Promise((resolve, reject) => { state.dialogs.push({ owner, options, resolve, reject }); }),
    stopRuntime,
    quit: () => { state.quits++; },
    reportError: error => state.errors.push(error),
    reportStopError: error => state.errors.push(error),
  });
  trayController = createDesktopTray({
    platform,
    createTray: () => { if (failTray) throw new Error('tray unavailable'); return tray; },
    buildMenu: items => items, isChinese: () => state.chinese,
    open: lifecycle.open, requestQuit: lifecycle.requestQuit,
    reportError: error => state.errors.push(error),
  });
  const controller = { ...lifecycle, ...trayController,
    dispose() { lifecycle.dispose(); trayController.dispose(); },
  };
  controller.attachWindow(window);
  function close() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    window.emit('close', event);
    return event.prevented;
  }
  return { state, window, tray, controller, close };
}

test('close keeps the window alive in the tray; all open actions restore it without quitting', async () => {
  const { state, window, tray, controller, close } = setup();
  assert.equal(controller.available(), true);
  assert.equal(tray.tooltip, 'PilotDeck');
  assert.deepEqual(tray.menu.filter(item => item.label).map(item => item.label), ['打开主界面', '退出程序']);
  for (const action of [() => tray.menu[0].click(), () => tray.emit('click'), () => tray.emit('double-click')]) {
    assert.equal(close(), true);
    assert.equal(window.visible, false);
    assert.equal(window.destroyed, false);
    action();
    await tick();
    assert.equal(window.visible, true);
  }
  assert.equal(state.restores, 3);
  assert.equal(state.quits, 0);
  assert.equal(state.dialogs.length, 0);
});

test('tray quit restores the main window, defaults to cancel, and never stacks dialogs', async () => {
  const { state, window, tray, close } = setup();
  close();
  tray.menu[2].click();
  tray.menu[2].click();
  await tick();
  assert.equal(window.visible, true);
  assert.equal(state.dialogs.length, 1);
  assert.equal(state.dialogs[0].owner, window);
  assert.deepEqual(state.dialogs[0].options.buttons, ['取消', '退出程序']);
  assert.equal(state.dialogs[0].options.cancelId, 0);
  assert.equal(state.dialogs[0].options.defaultId, 0);
  assert.equal(close(), true);
  assert.equal(window.visible, true, 'outstanding dialog parent must not be hidden');
  state.dialogs[0].resolve({ response: 0 });
  await tick();
  assert.equal(state.quits, 0);
  assert.equal(tray.destroyed, false);
  assert.equal(tray.menu[0].enabled, true);
  assert.equal(tray.menu[2].enabled, true);
  assert.equal(close(), true, 'cancelled quit must leave background behavior working');
});

test('only confirmation quits; hide immediately but retain tray until actual exit', async () => {
  const { state, window, tray, controller, close } = setup();
  const pending = controller.requestQuit();
  await tick();
  assert.equal(state.quits, 0);
  state.dialogs[0].resolve({ response: 1 });
  await pending;
  assert.equal(state.quits, 1);
  assert.equal(window.visible, false);
  assert.equal(close(), false);
  assert.equal(tray.destroyed, false, 'keep recovery access until will-quit');
  controller.dispose();
  assert.equal(tray.destroyed, true);
  assert.equal(controller.available(), false);
  await controller.requestQuit();
  assert.equal(state.dialogs.length, 1);
});

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`${platform}: confirmed quit hides before slow cleanup and blocks repeat activation`, async () => {
    let finishStop, stops = 0;
    const { state, window, tray, controller } = setup({ platform, stopRuntime: () => {
      stops++;
      assert.equal(window.visible, false, 'window hides before cleanup starts');
      assert.equal(state.quitting, true);
      return new Promise(resolve => { finishStop = resolve; });
    } });
    window.draft = 'keep unsent draft until cleanup succeeds';
    const pending = controller.requestQuit();
    await tick();
    assert.equal(window.visible, true, 'confirmation remains visible');
    state.dialogs[0].resolve({ response: 1 });
    await tick();
    assert.equal(stops, 1);
    assert.equal(state.quits, 0, 'process remains alive until cleanup finishes');
    assert.equal(window.destroyed, false);
    assert.equal(tray.menu[0].enabled, false);
    assert.equal(tray.menu[2].enabled, false);
    assert.equal(tray.menu[2].label, '正在退出…');
    assert.equal(tray.tooltip, 'PilotDeck — 正在退出…');
    const restores = state.restores;
    tray.menu[0].click();
    tray.menu[2].click();
    tray.emit('click');
    tray.emit('double-click');
    await controller.open();
    await controller.requestQuit();
    controller.beforeQuit({ preventDefault() {} });
    await tick();
    assert.equal(window.visible, false);
    assert.equal(state.restores, restores);
    assert.equal(stops, 1);
    assert.equal(state.dialogs.length, 1);
    state.chinese = false;
    controller.refreshMenu();
    assert.equal(tray.menu[2].label, 'Quitting…');
    finishStop();
    await pending;
    assert.equal(state.quits, 1);
    assert.equal(window.draft, 'keep unsent draft until cleanup succeeds');
  });
}

test('a window hide failure does not skip runtime cleanup', async () => {
  let stops = 0;
  const { state, window, controller } = setup({ stopRuntime: async () => { stops++; } });
  window.hide = () => { throw new Error('hide failed'); };
  await controller.requestQuit(true);
  assert.equal(stops, 1);
  assert.equal(state.quits, 1);
  assert.match(state.errors[0].message, /hide failed/);
});

test('update/system quit bypasses confirmation, including an outstanding dialog', async () => {
  const { state, window, controller, close } = setup();
  const pending = controller.requestQuit();
  await tick();
  state.quitting = true;
  assert.equal(close(), false);
  state.dialogs[0].resolve({ response: 1 });
  await pending;
  await controller.requestQuit();
  window.visible = false;
  await controller.open();
  assert.equal(window.visible, false);
  assert.equal(state.quits, 1, 'update quit bypasses confirmation');
  assert.equal(state.dialogs.length, 1);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform}: tray failure never hides the only accessible window`, () => {
    const { state, window, controller, close } = setup({ platform, failTray: true });
    assert.equal(controller.available(), false);
    assert.equal(close(), false);
    assert.equal(window.visible, true);
    assert.equal(state.errors.length, 1);
  });
}

test('Linux close keeps tasks running; tray activation restores and Quit asks for confirmation', async () => {
  const { state, window, tray, close } = setup({ platform: 'linux' });
  assert.equal(close(), true);
  assert.equal(window.visible, false);
  tray.emit('click');
  await tick();
  assert.equal(window.visible, true);
  assert.equal(close(), true);
  tray.menu[0].click();
  await tick();
  assert.equal(window.visible, true);
  tray.menu[2].click();
  await tick();
  assert.equal(state.dialogs.length, 1);
  assert.equal(state.dialogs[0].owner, window);
  state.dialogs[0].resolve({ response: 0 });
  await tick();
  assert.equal(state.quits, 0);
});

test('dialog failure is recoverable and language changes update both menu and confirmation', async () => {
  const { state, tray, controller } = setup();
  const first = controller.requestQuit();
  await tick();
  state.dialogs[0].reject(new Error('dialog failed'));
  await first;
  assert.equal(state.quits, 0);
  assert.equal(state.errors.length, 1);
  state.chinese = false;
  controller.refreshMenu();
  assert.equal(tray.menu[0].label, 'Open main window');
  const second = controller.requestQuit();
  await tick();
  assert.deepEqual(state.dialogs[1].options.buttons, ['Cancel', 'Quit']);
  state.dialogs[1].resolve({ response: 0 });
  await second;
});

test('File > Exit shares confirmation on Windows; other platforms retain native quit roles', () => {
  let requests = 0;
  for (const platform of ['win32', 'darwin', 'linux']) {
    const sections = buildApplicationMenu(platform, 'en', () => requests++);
    const items = sections.flatMap(section => section.submenu);
    if (platform === 'win32') {
      assert.equal(items.some(item => item.role === 'quit'), false);
      const exit = items.find(item => item.id === 'quit');
      assert.equal(exit.label, 'Exit');
      exit.click();
      assert.equal(requests, 1);
      assert.equal(items.find(item => item.label === 'Close Window').role, 'close');
    } else assert.equal(items.some(item => item.role === 'quit'), true);
  }
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: native quit is intercepted, cleanup happens once, failure can be retried`, async () => {
    let stops = 0;
    const { state, window, tray, controller, close } = setup({ platform, stopRuntime: async () => {
      assert.equal(window.visible, false);
      if (++stops === 1) throw new Error('process still alive');
    } });
    close();
    let prevented = 0;
    controller.beforeQuit({ preventDefault() { prevented++; } });
    controller.beforeQuit({ preventDefault() { prevented++; } });
    await tick();
    assert.equal(prevented, 2);
    assert.equal(state.dialogs.length, 1);
    state.dialogs[0].resolve({ response: 1 });
    await tick();
    assert.equal(state.quits, 0);
    assert.equal(state.quitting, false);
    assert.equal(window.visible, true);
    assert.equal(tray.menu[0].enabled, true);
    assert.equal(tray.menu[2].enabled, true);
    assert.equal(tray.menu[2].label, '退出程序');
    assert.equal(tray.tooltip, 'PilotDeck');
    assert.match(state.errors[0].message, /still alive/);
    assert.equal(close(), true);
    const pending = controller.requestQuit();
    await tick();
    state.dialogs[1].resolve({ response: 1 });
    await pending;
    assert.equal(stops, 2);
    assert.equal(state.quits, 1);
    controller.beforeQuit({ preventDefault() { assert.fail('final quit must proceed'); } });
  });
}

test('system quit supersedes an open confirmation and waits for cleanup exactly once', async () => {
  let finishStop, stops = 0;
  const { state, controller, close } = setup({ platform: 'darwin', stopRuntime: () => {
    stops++;
    return new Promise(resolve => { finishStop = resolve; });
  } });
  const confirmation = controller.requestQuit();
  await tick();
  const shutdown = controller.requestQuit(true);
  controller.beforeQuit({ preventDefault() {} });
  assert.equal(stops, 1);
  assert.equal(state.quits, 0);
  assert.equal(close(), false);
  state.dialogs[0].resolve({ response: 1 });
  await confirmation;
  assert.equal(stops, 1);
  finishStop();
  await shutdown;
  assert.equal(state.quits, 1);
});

test('Mac status icon click leaves menu handling to macOS; menu actions use shared lifecycle', async () => {
  const { state, window, tray, close } = setup({ platform: 'darwin' });
  close();
  tray.emit('click');
  await tick();
  assert.equal(window.visible, false);
  tray.menu[0].click();
  await tick();
  assert.equal(window.visible, true);
  tray.menu[2].click();
  await tick();
  assert.equal(state.dialogs.length, 1);
  state.dialogs[0].resolve({ response: 0 });
});

test('Mac can still hide and restore from Dock if the status icon is unavailable', async () => {
  const { window, controller, close } = setup({ platform: 'darwin', failTray: true });
  assert.equal(controller.available(), false);
  assert.equal(close(), true);
  assert.equal(window.visible, false);
  await controller.open();
  assert.equal(window.visible, true);
});

test('Mac full-screen close waits for the Space transition; a new open cancels pending hide', async () => {
  const { window, controller, close } = setup({ platform: 'darwin' });
  let exits = 0;
  window.isFullScreen = () => true;
  window.setFullScreen = value => { assert.equal(value, false); exits++; };
  close();
  assert.equal(window.visible, true);
  window.emit('enter-full-screen');
  assert.equal(exits, 2, 'closing during entry also requests exit once entry finishes');
  window.emit('leave-full-screen');
  assert.equal(window.visible, false);
  await controller.open();
  close();
  await controller.open();
  window.emit('leave-full-screen');
  assert.equal(window.visible, true, 'late full-screen events cannot undo an explicit restore');
});
