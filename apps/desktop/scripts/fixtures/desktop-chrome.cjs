// Isolated native smoke host: no real PilotDeck runtime, profile or user files.
const { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { isRendererEditingShortcut, windowChromeOptions, windowPalette, WINDOWS_CAPTION_HEIGHT } = require('../../dist/windowChrome');
const { buildApplicationMenu } = require('../../dist/applicationMenu');
const { WindowsCaptionMenu } = require('../../dist/windowsCaptionMenu');
const { linuxCaptionEntries, linuxCaptionAction } = require('../../dist/linuxCaptionMenu');
const { normalizeMenuState, emptyMenuState, commandEnabled } = require('../../dist/desktopCommands');
const { desktopAboutInfo, presentDesktopAbout } = require('../../dist/desktopAbout');
const profile = process.env.PILOTDECK_CHROME_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-chrome-'));
app.setPath('userData', profile);
app.setName('PilotDeck Chrome Test');
let window;
let state = { ...emptyMenuState };
let appearance = { language: 'en', themeMode: 'dark' };
let checks = 0;
let menuRequests = [];
let captionMenu;
let aboutDialogs = [], copiedVersion = '', openedWebsite = '';
function menuTemplate() {
  return buildApplicationMenu(process.platform, appearance.language, undefined, {
    state, dispatch: command => { if (commandEnabled(command, state)) window.webContents.send('pilotdeck:command', command); },
    help: action => {
      if (action === 'about') void presentDesktopAbout({ language: appearance.language, appVersion: '0.1.0-test',
        metadata: { version: '2026.930.0-test', buildTime: '2026-09-30T04:00:00Z', commitSha: 'abc123fixture' },
        platform: process.platform, arch: process.arch, osRelease: os.release(), versions: process.versions }, {
        showDialog: async options => { aboutDialogs.push(options); return { response: global.aboutResponse || 0 }; },
        copy: text => { copiedVersion = text; }, openWebsite: async url => { openedWebsite = url; },
      });
    },
  });
}
function refresh() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  if ((process.platform === 'win32' || process.platform === 'linux') && window) window.setMenuBarVisibility(false);
  if (process.platform === 'linux' && window && !window.isDestroyed()) window.webContents.send('pilotdeck:application-menu-updated');
}
function publish() {
  if (!window) return;
  const fullscreen = window.isFullScreen();
  const palette = windowPalette(nativeTheme.shouldUseDarkColors, process.platform, appearance.lightAppearance);
  window.setBackgroundColor(palette.background);
  if ((process.platform === 'win32' || process.platform === 'linux') && !fullscreen) window.setTitleBarOverlay({
    color: palette.caption,
    symbolColor: palette.symbol, height: WINDOWS_CAPTION_HEIGHT,
  });
  window.webContents.send('pilotdeck:window-state', { fullscreen, dark: nativeTheme.shouldUseDarkColors, palette });
}
ipcMain.on('pilotdeck:get-appearance', e => { e.returnValue = appearance; });
ipcMain.on('pilotdeck:get-window-state', e => { e.returnValue = { fullscreen: window.isFullScreen(), dark: nativeTheme.shouldUseDarkColors, palette: windowPalette(nativeTheme.shouldUseDarkColors, process.platform, appearance.lightAppearance) }; });
ipcMain.handle('pilotdeck:set-appearance', (_e, value) => { appearance = value; nativeTheme.themeSource = value.themeMode; publish(); refresh(); });
ipcMain.handle('pilotdeck:menu-state', (_e, value) => { state = normalizeMenuState(value); refresh(); });
ipcMain.handle('pilotdeck:get-runtime-info', () => null);
ipcMain.handle('pilotdeck:about-info', () => desktopAboutInfo({ language: appearance.language, appVersion: '0.1.0-test',
  metadata: { version: '2026.930.0-test', buildTime: '2026-09-30T04:00:00Z', commitSha: 'abc123fixture' },
  platform: process.platform, arch: process.arch, osRelease: os.release(), versions: process.versions }));

ipcMain.handle('pilotdeck:update-check', () => { checks++; return { current: { version: '0.1.0-test' }, latest: null, hasUpdate: false, canDownload: false, checkUnavailable: false }; });
ipcMain.handle('pilotdeck:update-status', () => ({ state: 'idle', progress: 0 }));
ipcMain.handle('pilotdeck:show-menu', (_e, request) => {
  menuRequests.push(request || { id: 'all' });
  captionMenu ||= new WindowsCaptionMenu(window, menuTemplate, items => Menu.buildFromTemplate(items), () => screen.getCursorScreenPoint());
  return captionMenu.show(request);
});
ipcMain.handle('pilotdeck:linux-menu-items', (_e, id) => {
  if (process.platform !== 'linux') return [];
  menuRequests.push({ id });
  return linuxCaptionEntries(menuTemplate(), id);
});
ipcMain.handle('pilotdeck:linux-menu-activate', (_e, request) => {
  if (process.platform !== 'linux') return false;
  const item = linuxCaptionAction(menuTemplate(), request?.id, request?.index);
  if (!item) return false;
  if (item.role) {
    const contents = window.webContents;
    switch (item.role) {
      case 'undo': contents.undo(); break;
      case 'redo': contents.redo(); break;
      case 'cut': contents.cut(); break;
      case 'copy': contents.copy(); break;
      case 'paste': contents.paste(); break;
      case 'selectAll': contents.selectAll(); break;
      case 'resetZoom': contents.setZoomLevel(0); break;
      case 'zoomIn': contents.setZoomLevel(contents.getZoomLevel() + 1); break;
      case 'zoomOut': contents.setZoomLevel(contents.getZoomLevel() - 1); break;
      case 'togglefullscreen': window.setFullScreen(!window.isFullScreen()); break;
      case 'reload': contents.reload(); break;
      case 'close': window.close(); break;
      case 'quit': app.quit(); break;
    }
  } else item.click?.();
  return true;
});
nativeTheme.on('updated', publish);
global.chromeTest = { state: () => state, checks: () => checks, menuRequests: () => menuRequests, closeMenu: () => captionMenu?.close(), refreshMenu: refresh,
  about: () => ({ dialogs: aboutDialogs, copiedVersion, openedWebsite }) };
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  window = new BrowserWindow({ ...windowChromeOptions(process.platform, true), show: false, width: 1320, height: 900,
    autoHideMenuBar: process.platform === 'win32' || process.platform === 'linux',
    webPreferences: { preload: path.resolve(__dirname, '../../dist/preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false },
  });
  window.once('ready-to-show', () => window.show());
  window.on('enter-full-screen', () => setImmediate(publish));
  window.on('leave-full-screen', () => setImmediate(publish));
  window.webContents.on('before-input-event', (_event, input) => {
    window.webContents.setIgnoreMenuShortcuts(isRendererEditingShortcut(process.platform, input));
  });
  refresh();
  await window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
// The parent removes its temporary profile after Chromium releases Windows locks.
