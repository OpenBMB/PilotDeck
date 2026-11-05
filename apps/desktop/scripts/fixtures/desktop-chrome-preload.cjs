// Keep production chrome in use; fixture-only controls travel over ordinary IPC.
require('../../dist/preload.js');
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pilotdeckChromeFixture', {
  closeMenu: () => ipcRenderer.invoke('pilotdeck:chrome-close-menu'),
});
