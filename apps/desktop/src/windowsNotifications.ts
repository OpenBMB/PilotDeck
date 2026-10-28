import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const TOAST_ACTIVATOR_CLSID = '{785E87AC-C88F-49ED-99B6-6617D2B67638}';

/** Register the current user's identity before the first toast, including NSIS
 * all-users installs. Electron owns COM activation and native Toast rendering. */
export async function registerWindowsNotifications(appId: string, displayName = 'PilotDeck', activatorClsid = TOAST_ACTIVATOR_CLSID): Promise<void> {
  // IconUri is an image asset, not an executable resource reference. The Start
  // Menu shortcut can use an EXE icon, but Notification Center needs a PNG.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'icon.png')
    : path.join(__dirname, '..', 'resources', 'icons', 'icon.png');
  if (!fs.existsSync(iconPath)) throw new Error('PilotDeck notification icon is missing');
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  fs.mkdirSync(programs, { recursive: true });
  const shortcut = path.join(programs, `${displayName}.lnk`);
  if (!shell.writeShortcutLink(shortcut, 'create', {
    target: process.execPath, cwd: path.dirname(process.execPath),
    description: displayName, icon: process.execPath, iconIndex: 0,
    appUserModelId: appId, toastActivatorClsid: activatorClsid,
  })) throw new Error('Could not register the PilotDeck notification shortcut');
  const registry = `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
  const run = promisify(execFile);
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  for (const [name, value] of [
    ['DisplayName', displayName], ['IconUri', iconPath],
    ['CustomActivator', activatorClsid],
  ]) {
    await run(reg, ['add', registry, '/v', name, '/t', name === 'IconUri' ? 'REG_EXPAND_SZ' : 'REG_SZ', '/d', value, '/f'], { windowsHide: true, timeout: 10000 });
  }
}
