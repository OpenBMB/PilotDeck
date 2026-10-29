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
const { installUpdateDownloadControl, PausableUpdateHttpExecutor } = require('../dist/updateDownload.js');
const { verifyDownloadedFile } = require('../dist/updates.js');
const { createUpdateController } = require('../dist/updates.js');
const { createUpdateNetwork } = require('../dist/updateNetwork.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error('Timed out waiting for download'); await sleep(25); }
}

let directory, server;
const timeout = setTimeout(() => { console.error('Download integration test timed out'); app.exit(1); }, 120000);
(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-update-download-'));
  app.setPath('userData', directory);
  await app.whenReady();
  const body = Buffer.alloc(4 * 1024 * 1024, 0x61);
  const sha512 = createHash('sha512').update(body).digest('base64');
  const manifest = { version: '2026.1002.0', files: [{ url: 'update-linux-arm64.deb', size: body.length, sha512 }] };
  let payloadRequests = 0, openPayloads = 0, feedRequests = 0;
  server = http.createServer((request, response) => {
    if (request.url === '/stalled') return;
    if (request.url === '/html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html>gateway error</html>'); return; }
    if (request.url === '/wrong-size') { response.writeHead(200, { 'Content-Length': 5 }); response.end('error'); return; }
    if (request.url === '/bad-range') { response.writeHead(206, { 'Content-Range': 'bytes 0-3/999' }); response.end('oops'); return; }
    if (request.url === '/no-range' && request.headers.range) { response.writeHead(416); response.end(); return; }
    if (request.url === '/range') {
      response.writeHead(206, { 'Content-Range': `bytes 0-262143/${body.length}`, 'Content-Length': 262144 });
      response.end(body.subarray(0, 262144)); return;
    }
    if (request.url.startsWith('/bad/') && !request.url.includes('.yml')) { response.writeHead(503); response.end(); return; }
    if (request.url.split('?')[0].endsWith('.yml')) { feedRequests++; response.end(JSON.stringify(manifest)); return; }
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/update-linux-arm64.deb' }); response.end(); return; }
    if (request.url === '/broken') { response.writeHead(200, { 'Content-Length': body.length }); response.write(body.subarray(0, 65536)); setTimeout(() => response.destroy(), 100); return; }
    if (!request.headers.range) payloadRequests++;
    openPayloads++;
    const chunked = request.url.startsWith('/chunked/');
    response.writeHead(200, { ...(chunked ? {} : { 'Content-Length': body.length }), 'Content-Type': 'application/octet-stream' });
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= body.length) { clearInterval(timer); response.end(); return; }
      response.write(body.subarray(offset, offset + 65536)); offset += 65536;
    }, chunked ? 500 : 35);
    response.on('close', () => { clearInterval(timer); openPayloads--; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const boundedTransport = new PausableUpdateHttpExecutor(undefined, 100);
  const stalledRequest = { protocol: 'http:', hostname: '127.0.0.1', port: server.address().port, path: '/stalled' };
  await assert.rejects(boundedTransport.request(stalledRequest), /cancelled/);
  const cancelledFeed = boundedTransport.request(stalledRequest);
  boundedTransport.cancel();
  await assert.rejects(cancelledFeed, /cancelled/);
  const network = createUpdateNetwork({ setProxy: async () => {}, closeAllConnections: async () => {}, clearAuthCache: async () => {} }, () => undefined, {});
  // This fixture ignores Range: sampling must still abort the response early.
  assert.ok(await network.probe(`${base}/redirect`) > 0);
  for (const route of ['/html', '/wrong-size', '/bad-range', '/broken']) {
    await assert.rejects(network.probe(`${base}${route}`, undefined, body.length));
  }
  for (const route of ['/range', '/no-range', '/chunked/probe']) {
    assert.ok(await network.probe(`${base}${route}`, undefined, body.length) > 0);
  }
  await until(() => openPayloads === 0);
  const abortProbe = new AbortController();
  const probing = network.probe(`${base}/redirect`, abortProbe.signal);
  abortProbe.abort();
  await assert.rejects(probing);
  payloadRequests = 0;
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
  await fs.rm(pending, { recursive: true, force: true });
  let installed = 0;
  updater.quitAndInstall = () => { installed++; };
  const releaseAsset = { name: manifest.files[0].url, size: body.length, sha512,
    sha256: createHash('sha256').update(body).digest('hex'), platform: 'linux', arch: 'arm64' };
  const controllerOptions = { updater, repository: 'fixture/PilotDeck', platform: 'linux', arch: 'arm64',
    version: adapter.version, packaged: true, downloadControl: transport,
    downloadAvailable: async (_release, asset, signal) => Number.isFinite(await network.probe(`${base}/${asset.name}`, signal, asset.size)),
    latestRelease: async () => ({ version: manifest.version, tagName: 'v2026.10.02', assets: [releaseAsset] }),
    downloadBases: async () => [`${base}/bad/`, `${base}/`], compareVersions: () => -1,
    prepareToInstall: async () => {}, recoverRuntime: async () => {} };
  const controller = createUpdateController(controllerOptions);
  const legacyFeedRequests = feedRequests;
  controller.start(); await controller.wait();
  assert.equal(controller.status().state, 'installing');
  assert.equal(installed, 1);
  assert.equal(feedRequests, legacyFeedRequests, 'JSON updater requested a legacy YAML feed');
  // Exercise an actual chunked payload for longer than the watchdog window.
  // electron-updater emits no progress events without Content-Length, but the
  // transport is continuously receiving 128 KiB/s and must not switch routes.
  await fs.rm(pending, { recursive: true, force: true });
  const chunkedUpdater = new DebUpdater(null, adapter);
  chunkedUpdater._testOnlyOptions = { platform: 'linux' };
  chunkedUpdater.logger = updater.logger;
  chunkedUpdater.quitAndInstall = () => { installed++; };
  const chunkedTransport = installUpdateDownloadControl(chunkedUpdater);
  const chunkedProgress = [];
  chunkedUpdater.on('download-progress', value => chunkedProgress.push(value));
  const chunkedController = createUpdateController({ ...controllerOptions, updater: chunkedUpdater, downloadControl: chunkedTransport,
    downloadBases: async () => [`${base}/chunked/`, `${base}/`] });
  const previousPayloadRequests = payloadRequests;
  const chunkedStarted = Date.now();
  chunkedController.start(); await chunkedController.wait();
  assert.ok(Date.now() - chunkedStarted > 30000, 'Chunked transfer did not cross the watchdog window');
  assert.equal(chunkedProgress.length, 0, 'Fixture unexpectedly emitted upstream download-progress');
  assert.equal(chunkedTransport.receivedBytes(), body.length);
  assert.equal(payloadRequests - previousPayloadRequests, 1, 'Healthy chunked transfer triggered a retry');
  assert.equal(chunkedController.status().state, 'installing');
  assert.equal(installed, 2);
  assert.equal(feedRequests, legacyFeedRequests, 'JSON fallback requested a legacy YAML feed');
  console.log('Real updater: chunked payload without Content-Length passed the 30-second watchdog with zero progress events, no retry and a verified install.');
  console.log('Real updater: bounded probes reject gateway pages and wrong sizes, support Range rejection, redirects and cancellation; JSON-only fallback installs exactly once without fetching YML.');
  console.log('Real updater: pause freezes file bytes, resume uses one request and validates checksums; redirects, paused cancellation/cache cleanup, restart, network failure and checksum failure passed.');
})().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  clearTimeout(timeout);
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  try {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  } catch (error) {
    // Chromium can keep its dictionary open until process exit on Windows.
    // Do not leave a successful headless test running forever during cleanup.
    if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(error.code)) {
      console.error(error); code = 1;
    }
  } finally { app.exit(code); }
}
