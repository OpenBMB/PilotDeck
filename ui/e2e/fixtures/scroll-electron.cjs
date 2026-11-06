// Renderer acceptance only: no application services, credentials or user profile.
const { app, BrowserWindow } = require('electron');
if (!process.env.PILOTDECK_SCROLL_PROFILE) throw new Error('An isolated profile is required');
app.setPath('userData', process.env.PILOTDECK_SCROLL_PROFILE);
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1100, height: 800, useContentSize: true, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
