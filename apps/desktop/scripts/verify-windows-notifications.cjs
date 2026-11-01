// Run with Electron; uses a separate notification identity and cleans it up.
const { app, Notification, shell } = require('electron');
const { registerWindowsNotifications } = require('../dist/windowsNotifications');
const { nativeNotificationOptions } = require('../dist/notifications');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const id = 'cn.pilotdeck.notification-smoke';
const name = 'PilotDeck Notification Smoke';
const clsid = '{36E048E8-DA2A-45D7-9968-848E8768268E}';
app.setName(name);
app.setAppUserModelId(id);
app.setToastActivatorCLSID(clsid);
let notification;
async function run() {
  await registerWindowsNotifications(id, name, clsid);
  const shortcut = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`);
  assert.equal(shell.readShortcutLink(shortcut).appUserModelId, id);
  const iconRegistration = execFileSync(path.join(process.env.SystemRoot, 'System32', 'reg.exe'),
    ['query', `HKCU\\Software\\Classes\\AppUserModelId\\${id}`, '/v', 'IconUri'], { encoding: 'utf8', windowsHide: true });
  assert.match(iconRegistration, /REG_EXPAND_SZ/);
  assert.ok(iconRegistration.includes(path.resolve(__dirname, '../resources/icons/icon.png')));
  assert.equal(fs.readFileSync(path.resolve(__dirname, '../resources/icons/icon.png')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(Notification.isSupported(), true);
  notification = new Notification(nativeNotificationOptions('win32', {
    title: 'PilotDeck 系统通知验证', body: 'Windows 原生通知接口投递验证。', silent: true,
  }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native toast show event timed out')), 15000);
    notification.once('show', () => { clearTimeout(timer); resolve(); });
    notification.once('failed', (_event, error) => { clearTimeout(timer); reject(new Error(error)); });
    notification.show();
  });
  console.log('PASS: Start Menu AUMID, PNG notification icon registration and native Windows Toast show event');
  if (process.argv.includes('--visual-check')) await new Promise(resolve => setTimeout(resolve, 60000));
}
app.whenReady().then(run).then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  notification?.close();
  fs.rmSync(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`), { force: true });
  const reg = path.join(process.env.SystemRoot, 'System32', 'reg.exe');
  for (const key of [`HKCU\\Software\\Classes\\AppUserModelId\\${id}`, `HKCU\\Software\\Classes\\CLSID\\${clsid}`]) {
    try { execFileSync(reg, ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
  app.exit(code);
}
