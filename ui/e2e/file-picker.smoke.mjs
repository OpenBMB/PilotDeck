// Run with Vite on port 5187. Real preload/IPC/native File objects; controlled
// dialog results cover selection without sending test files to any server.
import { _electron as electron, chromium, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-picker-smoke-'));
const folder = path.join(profile, 'upload-folder');
await fs.mkdir(path.join(folder, 'nested'), { recursive: true });
await fs.writeFile(path.join(folder, 'hello.txt'), 'hello');
await fs.writeFile(path.join(folder, 'nested', 'world.txt'), 'world');
const first = path.join(folder, 'hello.txt'), second = path.join(folder, 'nested', 'world.txt');
const large = path.join(profile, 'large.bin');
const largeFile = await fs.open(large, 'w'); await largeFile.truncate(256 * 1024 * 1024); await largeFile.close();
const imported = path.join(profile, 'settings.json');
await fs.writeFile(imported, '{"test":true}');
const html = `<!doctype html><html><head><title>PilotDeck file picker test</title></head><body style="padding:70px 16px">
<label>Files <input id="files" type="file" multiple></label>
<label>Directory <input id="directory" type="file" webkitdirectory multiple></label>
<label>Images <input id="images" type="file" accept="image/png,image/jpeg,image/webp"></label>
<label>Import <input id="import" type="file" accept="application/json,.json"></label>
<iframe id="frame" src="/picker-frame"></iframe><output id="result"></output>
<script type="module">import { installDesktopFilePicker } from '/src/lib/desktopFilePicker.ts'; installDesktopFilePicker(); window.pickerReady=true;
document.addEventListener('change',e=>{window.lastFiles=Array.from(e.target.files||[]);document.querySelector('#result').textContent=String(window.lastFiles.length);});
</script></body></html>`;
const frameHtml = '<!doctype html><html><body><input type="file" id="frame-file"><script>document.querySelector("input").onchange=e=>window.lastFiles=Array.from(e.target.files);</script></body></html>';
async function prepare(page) {
  await page.route('**/picker-test', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/picker-frame*', r => r.fulfill({ contentType: 'text/html', body: frameHtml }));
  await page.goto('http://127.0.0.1:5187/picker-test');
  await expect.poll(() => page.evaluate(() => window.pickerReady)).toBe(true);
}
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)(path.join(root, 'apps/desktop/node_modules/electron')),
  args: [path.join(root, 'apps/desktop/scripts/fixtures/appearance.cjs')],
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')), PILOTDECK_APPEARANCE_PROFILE: profile },
});
const pick = files => app.evaluate((_electron, filePaths) => { globalThis.filePickerResults = [{ canceled: !filePaths.length, filePaths }]; }, files);
try {
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await prepare(page);
  await pick([first, second]); await page.locator('#files').click();
  await expect.poll(async () => ({ calls: (await app.evaluate(() => globalThis.filePickerCalls)).length, errors: await app.evaluate(() => globalThis.filePickerErrors), count: await page.locator('#files').evaluate(e => e.files.length) })).toEqual({ calls: 1, errors: [], count: 2 });
  await expect(page.locator('#result')).toHaveText('2');
  expect(await page.evaluate(async () => Promise.all(window.lastFiles.map(f => f.text())))).toEqual(['hello', 'world']);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.debugger.isAttached())).toBe(false);
  await pick([]); await page.locator('#files').click();
  await expect(page.locator('#files')).not.toHaveAttribute('data-pilotdeck-file-picker');
  expect(await page.locator('#files').evaluate(e => e.files.length)).toBe(2);
  await pick([folder]); await page.locator('#directory').click();
  await expect.poll(() => page.locator('#directory').evaluate(e => e.files.length)).toBe(2);
  expect(await page.locator('#directory').evaluate(e => Array.from(e.files, f => f.webkitRelativePath).sort())).toEqual(['upload-folder/hello.txt', 'upload-folder/nested/world.txt']);
  const image = path.join(root, 'apps/desktop/resources/icons/icon.png');
  await pick([image]); await page.locator('#images').click();
  await expect.poll(() => page.locator('#images').evaluate(e => e.files.length)).toBe(1);
  expect(await page.locator('#images').evaluate(e => e.files[0].type)).toBe('image/png');
  expect((await app.evaluate(() => globalThis.filePickerCalls)).at(-1).filters[0].extensions).toEqual(['png', 'jpg', 'jpeg', 'webp']);
  await pick([imported]); await page.locator('#import').click();
  await expect.poll(() => page.locator('#import').evaluate(e => e.files[0]?.name)).toBe('settings.json');
  expect(await page.locator('#import').evaluate(e => e.files[0].text())).toBe('{"test":true}');
  expect((await app.evaluate(() => globalThis.filePickerCalls)).at(-1).filters[0].extensions).toEqual(['json']);
  await page.locator('#files').evaluate(e => e.value = '');
  await pick([large]); await page.locator('#files').click();
  await expect.poll(() => page.locator('#files').evaluate(e => e.files[0]?.size)).toBe(256 * 1024 * 1024);
  await pick([first]); await page.frameLocator('#frame').locator('#frame-file').click();
  await expect.poll(() => page.frameLocator('#frame').locator('#frame-file').evaluate(e => e.files.length)).toBe(1);
  await page.locator('#frame').evaluate(e => e.src = '/picker-frame?reload');
  await pick([second]); await page.frameLocator('#frame').locator('#frame-file').click();
  await expect.poll(() => page.frameLocator('#frame').locator('#frame-file').evaluate(e => e.files[0]?.name)).toBe('world.txt');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.openDevTools({ mode: 'detach' }));
  await page.locator('#files').evaluate(e => e.value = '');
  await pick([second]); await page.locator('#files').click();
  await expect.poll(() => page.locator('#files').evaluate(e => e.files[0]?.name)).toBe('world.txt');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened())).toBe(true);
  expect(errors).toEqual([]);
  console.log('PASS: actual Electron shared picker, cancellation, multi-select, folder paths, image filters, 256MB native File, owned iframe and existing DevTools');
} finally { await app.close(); }
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage(); await prepare(page);
  const chooser = page.waitForEvent('filechooser'); await page.locator('#files').click();
  await (await chooser).setFiles([first, second]);
  await expect(page.locator('#result')).toHaveText('2');
  expect(await page.evaluate(() => window.pilotdeckDesktop)).toBe(undefined);
  console.log('PASS: browser retains its normal file chooser and multi-select');
} finally { await browser.close(); }
