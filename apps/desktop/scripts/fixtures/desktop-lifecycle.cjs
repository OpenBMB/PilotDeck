const electron = require('electron');
const { app, BrowserWindow, Menu } = electron;
const Module = require('node:module');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const scenario = process.env.PILOTDECK_TEST_SCENARIO || 'normal';
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });

app.setPath('userData', path.join(__dirname, 'profile'));
app.setName('PilotDeck Tray Test');
fs.mkdirSync(app.getPath('userData'), { recursive: true });
const appearance = path.join(app.getPath('userData'), 'appearance.json');
if (!fs.existsSync(appearance)) fs.writeFileSync(appearance, '{"language":"zh-CN","themeMode":"system"}');

if (process.argv.includes('--tray-second-instance')) {
  assert.equal(app.requestSingleInstanceLock(), false, 'second process must not start a runtime');
  app.quit();
} else {
  let tray, menu, runtimePid, updateOptions;
  let failStop = false;
  let quitConfirmedAt = 0, slowStopChecks = 0;
  const stopErrors = [];
  let completedAssertions = false;
  const dialogs = [];
  const nativeDialog = new Proxy(electron.dialog, {
    get(target, key) {
      if (key === 'showMessageBox' && scenario !== 'manual') return (owner, options) => new Promise(resolve => dialogs.push({ owner, options, resolve }));
      if (key === 'showErrorBox') return (title, message) => {
        stopErrors.push(message);
        if (scenario !== 'stop-failure' || stopErrors.length !== 1 || failStop) {
          console.error(`${title}: ${message}`);
          app.exit(1);
        }
      };
      return target[key];
    },
  });
  const api = new Proxy(electron, {
    get(target, key) {
      if (key === 'dialog') return nativeDialog;
      if (key === 'Tray') return function (icon) {
        if (process.platform === 'darwin') {
          assert.equal(icon.isTemplateImage(), true);
          assert.deepEqual(icon.getSize(), {width: 18, height: 18});
          assert.ok(icon.getScaleFactors().includes(2), 'Retina status icon is packaged');
        }
        tray = new electron.Tray(icon);
        const setMenu = tray.setContextMenu.bind(tray);
        tray.setContextMenu = value => { menu = value; setMenu(value); };
        return tray;
      };
      return target[key];
    },
  });
  const load = Module._load;
  Module._load = function (id, parent, ...rest) {
    if (id === 'electron') return api;
    if (id === 'electron-updater' || id.startsWith('electron-updater/'))
      id = path.join(process.env.PILOTDECK_TRAY_TEST_UPDATER, id.slice('electron-updater'.length));
    const result = load.call(this, id, parent, ...rest);
    if (id === './updates') return { ...result, createUpdateController(options) {
      updateOptions = options;
      return result.createUpdateController(options);
    } };
    if (path.basename(id) === 'processTree.js') return { ...result, stopProcessTree: async (...args) => {
      if (failStop) { failStop = false; throw new Error('Injected cleanup failure'); }
      if (scenario === 'slow-quit' && slowStopChecks++ === 0) {
        const window = BrowserWindow.getAllWindows()[0];
        assert.equal(window.isVisible(), false, 'UI hides before runtime cleanup starts');
        assert.equal(window.isDestroyed(), false, 'keep the renderer for cleanup recovery');
        const latency = Date.now() - quitConfirmedAt;
        assert.ok(latency < 500, `quit acknowledgement took ${latency}ms`);
        assert.equal(menu.items[0].enabled, false);
        assert.equal(menu.items[2].enabled, false);
        assert.equal(menu.items[2].label, '正在退出…');
        menu.items[0].click();
        menu.items[2].click();
        tray.emit('click');
        tray.emit('double-click');
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.equal(window.isVisible(), false, 'activation cannot reopen UI during cleanup');
        assert.equal(dialogs.length, 1, 'repeat quit cannot open another confirmation');
        assert.equal(await window.webContents.executeJavaScript('window.unsentDraft'), 'preserve this');
        console.log(`[slow-quit] UI hidden in ${latency}ms; stayed hidden through 1200ms cleanup delay`);
      }
      try { return await result.stopProcessTree(...args); }
      catch (error) { console.error('Unexpected native cleanup failure:', error); app.exit(1); throw error; }
    } };
    return result;
  };
  require('./dist/main.js');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate, description) {
    fs.writeFileSync(path.join(__dirname, 'step'), description);
    console.log(`[${scenario}] ${description}`);
    const deadline = Date.now() + 20_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, description);
      await pause(30);
    }
  }
  app.on('will-quit', () => {
    // Registered after main's tray disposer and after managed process cleanup.
    assert.equal(completedAssertions, true, 'app must not exit before the checks finish');
    assert.equal(tray.isDestroyed(), true);
    if (scenario === 'slow-quit') assert.ok(slowStopChecks > 0, 'delayed cleanup was exercised');
    assert.equal(alive(runtimePid), false, 'quit must stop the real runtime process');
    for (const suffix of ['.task', '.gateway']) {
      const file = process.env.PILOTDECK_TRAY_TEST_PID + suffix;
      if (scenario === 'startup-quit' && !fs.existsSync(file)) continue;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      assert.equal(alive(pid), false, `quit must stop ${suffix}`);
    }
    fs.writeFileSync(path.join(__dirname, 'passed'), 'ok');
  });
  app.whenReady().then(async () => {
    await until(() => BrowserWindow.getAllWindows().length > 0, 'startup window exists');
    const window = BrowserWindow.getAllWindows()[0];
    if (scenario === 'startup-quit') {
      await until(() => fs.existsSync(process.env.PILOTDECK_TRAY_TEST_PID), 'server starts before its readiness delay');
      runtimePid = Number(fs.readFileSync(process.env.PILOTDECK_TRAY_TEST_PID, 'utf8'));
      assert.ok(!window.webContents.getURL().startsWith('http:'), 'quit during startup, not after readiness');
      app.quit();
      await until(() => dialogs.length === 1, 'early quit confirmation');
      completedAssertions = true;
      dialogs[0].resolve({ response: 1 });
      return;
    }
    window.close();
    assert.equal(window.isDestroyed(), false);
    await until(() => window.webContents.getURL().startsWith('http://127.0.0.1:'), 'runtime page loads');
    await until(() => !window.webContents.isLoading(), 'runtime page finishes loading');
    assert.equal(window.isVisible(), false, 'finishing startup must not reopen a window the user closed');
    if (process.platform === 'darwin') app.emit('activate'); else tray.emit('click');
    await until(() => window.isVisible(), 'restore after background startup');
    const url = window.webContents.getURL();
    runtimePid = Number(fs.readFileSync(process.env.PILOTDECK_TRAY_TEST_PID, 'utf8'));
    await window.webContents.executeJavaScript('window.unsentDraft = "preserve this"');
    assert.ok(tray && !tray.isDestroyed());
    await until(() => fs.existsSync(process.env.PILOTDECK_TRAY_TEST_PID + '.gateway'), 'gateway started');
    if (scenario === 'manual') { completedAssertions = true; return; }
    if (scenario === 'slow-quit') {
      menu.items[2].click();
      await until(() => dialogs.length === 1, 'tray quit confirmation before slow cleanup');
      assert.equal(window.isVisible(), true);
      completedAssertions = true;
      quitConfirmedAt = Date.now();
      dialogs[0].resolve({ response: 1 });
      return;
    }
    if (scenario === 'shutdown') {
      window.close();
      menu.items[2].click();
      await until(() => dialogs.length === 1, 'confirmation outstanding when shutdown begins');
      let prevented = false;
      completedAssertions = true;
      electron.powerMonitor.emit('shutdown', {preventDefault() { prevented = true; }});
      assert.equal(prevented, true);
      dialogs[0].resolve({ response: 1 });
      return;
    }
    if (scenario === 'update' || scenario === 'update-recovery') {
      await window.webContents.executeJavaScript('window.pilotdeckDesktop.getUpdateStatus()');
      assert.ok(updateOptions);
      await updateOptions.prepareToInstall();
      assert.equal(alive(runtimePid), false);
      if (scenario === 'update') {
        completedAssertions = true;
        app.quit();
        assert.equal(dialogs.length, 0, 'updater quit does not prompt again');
        return;
      }
      await updateOptions.recoverRuntime();
      await until(() => Number(fs.readFileSync(process.env.PILOTDECK_TRAY_TEST_PID, 'utf8')) !== runtimePid, 'failed install restarts runtime');
      runtimePid = Number(fs.readFileSync(process.env.PILOTDECK_TRAY_TEST_PID, 'utf8'));
      await until(() => !window.webContents.isLoading(), 'recovered UI loads');
      app.quit();
      await until(() => dialogs.length === 1, 'user quit protection restored after failed install');
      completedAssertions = true;
      dialogs[0].resolve({ response: 1 });
      return;
    }
    if (scenario === 'stop-failure') {
      window.close();
      failStop = true;
      app.quit();
      await until(() => dialogs.length === 1, 'quit confirmation before injected failure');
      dialogs[0].resolve({ response: 1 });
      await until(() => stopErrors.length === 1, 'cleanup error is reported');
      assert.equal(window.isVisible(), true);
      assert.equal(tray.isDestroyed(), false);
      window.close();
      await until(() => !window.isVisible(), 'cleanup failure leaves hiding available');
      app.quit();
      await until(() => dialogs.length === 2, 'cleanup can be retried');
      completedAssertions = true;
      dialogs[1].resolve({ response: 1 });
      return;
    }
    assert.equal(menu.items[0].label, '打开主界面');

    window.close();
    await until(() => !window.isVisible(), 'close hides the window');
    assert.equal(window.isDestroyed(), false);
    assert.equal(alive(runtimePid), true);
    assert.equal((await fetch(url)).status, 200, 'runtime responds while window is hidden');
    menu.items[0].click();
    await until(() => window.isVisible(), 'tray menu restores the window');
    assert.equal(await window.webContents.executeJavaScript('window.unsentDraft'), 'preserve this');
    window.minimize();
    await until(() => window.isMinimized(), 'window minimizes');
    const restored = new Promise(resolve => window.once('restore', resolve));
    if (process.platform === 'darwin') app.emit('activate'); else tray.emit('click');
    await restored;
    await until(() => !window.isMinimized() && window.isVisible(), 'tray click restores minimized window');

    if (process.platform === 'darwin') {
      const entered = new Promise(resolve => window.once('enter-full-screen', resolve));
      window.setFullScreen(true);
      await entered;
      assert.equal(window.isFullScreen(), true);
      window.close();
      await until(() => !window.isVisible(), 'full-screen close hides window');
      app.emit('activate');
      await until(() => window.isVisible(), 'Dock restores full-screen window');
      window.setFullScreen(false);
      await until(() => !window.isFullScreen(), 'leaves native full screen');
      app.hide();
      // Native app hiding is asynchronous; activate only after it completes.
      await until(() => app.isHidden(), 'application finishes hiding');
      app.emit('activate');
      await until(() => !app.isHidden() && window.isVisible(), 'Dock restores hidden application');
      assert.equal(await window.webContents.executeJavaScript('window.unsentDraft'), 'preserve this');
    }

    window.close();
    if (process.platform === 'win32') {
      const second = spawn(process.execPath, [__dirname, '--tray-second-instance'], { windowsHide: true, stdio: 'pipe' });
      const secondExit = new Promise((resolve, reject) => { second.once('error', reject); second.once('exit', resolve); });
      assert.equal(await secondExit, 0);
      await until(() => window.isVisible(), 'second instance restores the original window');
    } else {
      app.emit('activate');
      await until(() => window.isVisible(), 'Dock activation restores the original window');
    }
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(Number(fs.readFileSync(process.env.PILOTDECK_TRAY_TEST_PID, 'utf8')), runtimePid);

    window.close();
    menu.items[2].click();
    menu.items[2].click();
    await until(() => dialogs.length === 1, 'one quit dialog opens');
    assert.equal(window.isVisible(), true);
    assert.equal(dialogs[0].owner, window);
    assert.equal(dialogs[0].options.defaultId, 0);
    assert.deepEqual(dialogs[0].options.buttons, ['取消', '退出程序']);
    dialogs[0].resolve({ response: 0 });
    await pause(50);
    assert.equal(alive(runtimePid), true);
    window.close();
    await until(() => !window.isVisible(), 'cancel leaves close-to-tray working');
    if (process.platform === 'darwin') app.emit('activate'); else tray.emit('double-click');
    await until(() => window.isVisible(), 'double click restores the window');
    await window.webContents.executeJavaScript('window.pilotdeckDesktop.setAppearance({language:"en",themeMode:"system"})');
    assert.equal(menu.items[0].label, 'Open main window');
    if (process.platform === 'darwin') {
      // Native Dock Quit and the native quit menu role both enter app.quit().
      app.quit();
    } else {
      // Product actions may precede Exit; exercise the actual quit command.
      const exit = Menu.getApplicationMenu().getMenuItemById('quit');
      assert.ok(exit?.enabled, 'File > Exit is available');
      assert.equal(exit.label, 'Exit');
      exit.click();
    }
    await until(() => dialogs.length === 2, 'native quit uses the same confirmation');
    assert.deepEqual(dialogs[1].options.buttons, ['Cancel', 'Quit']);
    if (process.platform === 'darwin') {
      dialogs[1].resolve({ response: 0 });
      await pause(50);
      const nativeQuit = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.role === 'quit');
      assert.equal(nativeQuit.label, 'Quit PilotDeck');
      assert.match(nativeQuit.getDefaultRoleAccelerator(), /^Command(?:OrControl)?\+Q$/);
      Menu.sendActionToFirstResponder('terminate:');
      await until(() => dialogs.length === 3, 'application menu uses native quit protection');
    }
    await until(() => fs.existsSync(process.env.PILOTDECK_TRAY_TEST_PID + '.gateway'), 'gateway has started');
    completedAssertions = true;
    dialogs.at(-1).resolve({ response: 1 });
  }).catch(error => { console.error(error); app.exit(1); });
}
