// Run after desktop compile with Electron (not ELECTRON_RUN_AS_NODE).
// Uses a throttled local release server and real electron-updater transport;
// never runs an installer or contacts a published release.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { DebUpdater, CancellationToken } = require('electron-updater');
const { installUpdateDownloadControl } = require('../dist/updateDownload.js');
const { verifyDownloadedFile } = require('../dist/updates.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error('Timed out waiting for download'); await sleep(25); }
}

let directory, server;
const timeout = setTimeout(() => { console.error('Download integration test timed out'); app.exit(1); }, 60000);
(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-update-download-'));
  app.setPath('userData', directory);
  await app.whenReady();
  const body = Buffer.alloc(4 * 1024 * 1024, 0x61);
  const sha512 = createHash('sha512').update(body).digest('base64');
  const manifest = { version: '2026.1002.0', files: [{ url: 'update-linux-arm64.deb', size: body.length, sha512 }] };
  let payloadRequests = 0, openPayloads = 0;
  server = http.createServer((request, response) => {
    if (request.url.split('?')[0].endsWith('.yml')) { response.end(JSON.stringify(manifest)); return; }
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/update-linux-arm64.deb' }); response.end(); return; }
    if (request.url === '/broken') { response.writeHead(200, { 'Content-Length': body.length }); response.write(body.subarray(0, 65536)); setTimeout(() => response.destroy(), 100); return; }
    payloadRequests++; openPayloads++;
    response.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= body.length) { clearInterval(timer); response.end(); return; }
      response.write(body.subarray(offset, offset + 65536)); offset += 65536;
    }, 35);
    response.on('close', () => { clearInterval(timer); openPayloads--; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = path.join(directory, 'app-update.yml');
  await fs.writeFile(config, 'updaterCacheDirName: pilotdeck-update-download-test\n');
  const adapter = {
    version: '2026.1001.0', name: 'PilotDeck download test', isPackaged: true,
    appUpdateConfigPath: config, userDataPath: directory, baseCachePath: path.join(directory, 'cache'),
    whenReady: () => app.whenReady(), onQuit: () => {}, quit: () => { throw new Error('Must not install'); }, relaunch: () => { throw new Error('Must not relaunch'); },
  };
  const updater = new DebUpdater(null, adapter);
  updater._testOnlyOptions = { platform: 'linux' };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  updater.logger = { info() {}, debug() {}, warn() {}, error() {} };
  const transport = installUpdateDownloadControl(updater);
  updater.setFeedURL({ provider: 'generic', url: base });
  const checked = await updater.checkForUpdates();
  assert.equal(checked.isUpdateAvailable, true);
  const progress = []; updater.on('download-progress', value => progress.push(value));
  let completed = false;
  const task = updater.downloadUpdate(checked.cancellationToken).then(files => { completed = true; return files; });
  const pending = path.join(directory, 'cache', 'pilotdeck-update-download-test', 'pending');
  let partial;
  await until(async () => {
    const names = await fs.readdir(pending).catch(() => []);
    partial = names.find(name => name.startsWith('temp-'));
    return partial && (await fs.stat(path.join(pending, partial))).size >= 262144;
  });
  transport.pause(); await sleep(200);
  const frozenBytes = (await fs.stat(path.join(pending, partial))).size;
  await sleep(500);
  assert.equal((await fs.stat(path.join(pending, partial))).size, frozenBytes, 'Paused download kept writing');
  assert.equal(completed, false, 'Paused download finished');
  transport.resume();
  const files = await task;
  assert.equal(payloadRequests, 1, 'Resume started another payload request');
  assert.deepEqual(await fs.readFile(files[0]), body);
  await verifyDownloadedFile(files[0], { size: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  assert.ok(progress.length > 0);

  // Cancellation through the real updater removes its partial cache as well
  // as aborting the request; it must not leave a background writer behind.
  await fs.rm(pending, { recursive: true, force: true });
  const nativeToken = new CancellationToken();
  transport.pause();
  const nativeCancelled = updater.downloadUpdate(nativeToken).then(() => ({ success: true }), error => ({ error }));
  await until(async () => (await fs.readdir(pending).catch(() => [])).some(name => name.startsWith('temp-')));
  nativeToken.cancel();
  assert.ok((await nativeCancelled).error);
  await until(() => openPayloads === 0);
  assert.deepEqual(await fs.readdir(pending), []);

  // Pause before headers, redirects, repeated resume, cancellation and cleanup.
  const direct = path.join(directory, 'redirect.deb');
  const token = new CancellationToken();
  transport.pause();
  const cancelled = transport.download(new URL(`${base}/redirect`), direct, { cancellationToken: token, sha512 });
  const settled = cancelled.then(() => ({ success: true }), error => ({ error }));
  await until(() => openPayloads > 0); await sleep(150);
  assert.equal((await fs.stat(direct)).size, 0);
  token.cancel();
  assert.ok((await settled).error, 'Cancellation did not reject');
  await until(() => openPayloads === 0);
  transport.resume(); transport.resume();

  const recovered = path.join(directory, 'after-cancel.deb');
  await transport.download(new URL(`${base}/redirect`), recovered, { cancellationToken: new CancellationToken(), sha512 });
  assert.deepEqual(await fs.readFile(recovered), body);
  await assert.rejects(transport.download(new URL(`${base}/broken`), path.join(directory, 'broken.deb'), { cancellationToken: new CancellationToken(), sha512 }));
  await assert.rejects(transport.download(new URL(`${base}/update-linux-arm64.deb`), path.join(directory, 'checksum.deb'), { cancellationToken: new CancellationToken(), sha512: Buffer.alloc(64).toString('base64') }));
  console.log('Real updater: pause freezes file bytes, resume uses one request and validates checksums; redirects, paused cancellation/cache cleanup, restart, network failure and checksum failure passed.');
})().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  clearTimeout(timeout);
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  app.exit(code);
}
