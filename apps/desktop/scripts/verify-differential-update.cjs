// Real Electron HTTP + pinned builder blockmaps + NsisUpdater/MacUpdater.
// Inert bytes and private caches only; native installation is intercepted.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { gzipSync } = require('node:zlib');
const nativeFs = require('node:fs');
const { app } = require('electron');
app.commandLine.appendSwitch('disable-background-networking');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const { NsisUpdater, MacUpdater } = require('electron-updater');
const { createUpdateController } = require('../dist/updates.js');
const { installUpdateDownloadControl } = require('../dist/updateDownload.js');
const builderRequire = createRequire(require.resolve('electron-builder'));
const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { createBlockmap } = libRequire('./targets/differentialUpdateInfoBuilder');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
const until = async predicate => {
  const deadline = Date.now() + 10000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'Timed out waiting for fixture'); await sleep(10); }
};
let root, server, records = [], open = 0, scenario, newBytes, oldBytes, newMap, oldMap;
const timeout = setTimeout(() => { console.error('Differential qualification timed out'); app.exit(1); }, 180000);

(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-differential-'));
  app.setPath('userData', path.join(root, 'electron'));
  await app.whenReady();
  // Deterministic high-entropy content, with a large unchanged prefix/suffix.
  oldBytes = Buffer.alloc(4 * 1024 * 1024);
  let seed = 42;
  for (let i = 0; i < oldBytes.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; oldBytes[i] = seed & 255; }
  newBytes = Buffer.from(oldBytes);
  for (let i = 1024 * 1024; i < 1536 * 1024; i++) newBytes[i] ^= 0x5a;
  for (const [name, bytes] of [['old.exe', oldBytes], ['new.exe', newBytes]]) {
    const file = path.join(root, name);
    await fs.writeFile(file, bytes);
    await createBlockmap(file, null, { info: { emitArtifactBuildCompleted: async () => {} } }, null);
  }
  oldMap = await fs.readFile(path.join(root, 'old.exe.blockmap'));
  newMap = await fs.readFile(path.join(root, 'new.exe.blockmap'));
  server = http.createServer((req, res) => {
    const record = { path: req.url, range: req.headers.range, bytes: 0 };
    records.push(record); open++;
    let timer;
    res.once('close', () => { open--; clearInterval(timer); });
    const old = req.url.includes('2026.1105.0');
    if (req.url.endsWith('.blockmap')) {
      if (scenario === 'missing-map' && old) { res.writeHead(404); res.end(); return; }
      if (['stalled-map', 'cancel-map'].includes(scenario)) return;
      if (scenario === 'trickle-map') {
        timer = setInterval(() => { res.write(Buffer.from([0])); record.bytes++; }, 30);
        return;
      }
      const bytes = scenario === 'corrupt-map' ? Buffer.from('bad map')
        : scenario === 'invalid-map' ? gzipSync(JSON.stringify({ version: '2', files: [{ offset: 0, sizes: [-1], checksums: ['x'] }] }))
          : scenario === 'oversized-map' ? gzipSync(Buffer.alloc(33 * 1024 * 1024)) : old ? oldMap : newMap;
      res.end(bytes); record.bytes = bytes.length; return;
    }
    if (req.url.startsWith('/bad/')) { res.writeHead(503); res.end(); return; }
    if (record.range && scenario === 'redirect' && !req.url.startsWith('/redirect/')) {
      res.writeHead(302, { Location: `/redirect${req.url}` }); res.end(); return;
    }
    if (record.range && scenario === 'reject-range') { res.writeHead(416); res.end(); return; }
    if (record.range && ['stalled-range', 'cancel-before-headers'].includes(scenario)) return;
    const range = record.range && /^bytes=(\d+)-(\d+)$/.exec(record.range);
    let body = newBytes;
    if (range && scenario !== 'ignore-range') {
      body = newBytes.subarray(Number(range[1]), Number(range[2]) + 1);
      const headerStart = scenario === 'wrong-range' ? '0' : range[1];
      res.writeHead(206, { 'Content-Range': `bytes ${headerStart}-${range[2]}/${newBytes.length}`,
        ...(scenario === 'chunked-range' ? {} : { 'Content-Length': body.length }) });
    } else res.writeHead(200, { 'Content-Length': body.length });
    if (scenario === 'corrupt-all' || (range && scenario === 'corrupt-range')) { body = Buffer.from(body); body[0] ^= 1; }
    if (range && scenario === 'truncated-range') { res.write(body.subarray(0, 100)); res.destroy(); return; }
    if (range && ['pause', 'pause-deadline', 'cancel-paused', 'cancel-retry', 'cancel-before-headers', 'chunked-range'].includes(scenario)) {
      let offset = 0;
      timer = setInterval(() => {
        if (offset >= body.length) { clearInterval(timer); res.end(); return; }
        const bytes = body.subarray(offset, offset + 8192); offset += bytes.length;
        record.bytes += bytes.length; res.write(bytes);
      }, 10);
    } else { record.bytes = body.length; res.end(body); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let count = 0;
  async function run(name, platform = 'win32', settings = {}) {
    scenario = name; records = [];
    const directory = path.join(root, String(++count));
    await fs.mkdir(directory);
    const config = path.join(directory, 'app-update.yml');
    await fs.writeFile(config, 'updaterCacheDirName: fixture\n');
    const adapter = { version: '2026.1105.0', name: 'Differential fixture', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: directory, baseCachePath: path.join(directory, 'cache'),
      whenReady: () => app.whenReady(), onQuit() {}, quit() { throw new Error('Must not quit'); }, relaunch() { throw new Error('Must not relaunch'); } };
    const updater = platform === 'darwin' ? new MacUpdater(null, adapter) : new NsisUpdater(null, adapter);
    if (platform === 'darwin') updater.updateDownloaded = async (_file, event) => updater.emit('update-downloaded', event);
    const logs = [];
    updater.logger = { info: x => logs.push(String(x)), warn: x => logs.push(String(x)), error: x => logs.push(String(x)), debug() {} };
    const control = installUpdateDownloadControl(updater);
    // Short, real inactivity deadlines only for fault scenarios.
    if (name.startsWith('stalled') || ['pause-deadline', 'trickle-map'].includes(name)) control.metadataTimeoutMs = 150;
    const cache = path.join(directory, 'cache', 'fixture');
    await fs.mkdir(cache, { recursive: true });
    const oldFile = path.join(cache, platform === 'darwin' ? 'update.zip' : 'installer.exe');
    if (name !== 'missing-cache') await fs.writeFile(oldFile, name === 'corrupt-cache' ? Buffer.alloc(oldBytes.length) : oldBytes);
    if (name === 'cached-map') await fs.writeFile(path.join(cache, 'current.blockmap'), oldMap);
    if (name === 'corrupt-cached-map') await fs.writeFile(path.join(cache, 'current.blockmap'), 'corrupt');
    const filename = `PilotDeck-2026.1106.1-${platform === 'darwin' ? 'mac' : 'win'}-${process.arch}${platform === 'darwin' ? '.zip' : '-setup.exe'}`;
    const asset = (name, bytes) => ({ name, size: bytes.length, sha512: digest(bytes, 'sha512', 'base64'), sha256: digest(bytes, 'sha256', 'hex'), platform, arch: process.arch });
    const release = { version: '2026.1106.1', tagName: 'v2026.11.06-r2', differentialUpdates: true,
      assets: [asset(filename, newBytes), asset(`${filename}.blockmap`, newMap)], ...settings.release };
    if (name === 'corrupt-pending-cache') {
      const pending = path.join(cache, 'pending');
      await fs.mkdir(pending);
      await fs.writeFile(path.join(pending, filename), oldBytes);
      await fs.writeFile(path.join(pending, 'update-info.json'), JSON.stringify({ fileName: filename, sha512: release.assets[0].sha512 }));
    }
    let installed = 0, stopped = 0;
    updater.quitAndInstall = () => { installed++; };
    if (name === 'publisher-rejected') {
      await fs.writeFile(config, 'updaterCacheDirName: fixture\npublisherName: [Fixture]\n');
      updater.verifyUpdateCodeSignature = async () => 'Wrong publisher';
    }
    const controller = createUpdateController({ updater, repository: 'fixture/PilotDeck', platform, arch: process.arch,
      version: adapter.version, packaged: true, latestRelease: async () => release,
      downloadAvailable: async () => true, downloadBases: async () => name === 'route-fallback'
        ? [`${base}/bad/v2026.11.06-r2/`, `${base}/v2026.11.06-r2/`] : [`${base}/v2026.11.06-r2/`],
      compareVersions: () => -1, prepareToInstall: async () => { stopped++; }, recoverRuntime: async () => {},
      downloadControl: control, ...settings.controller });
    const originalWrite = nativeFs.createWriteStream;
    if (name === 'disk-full') nativeFs.createWriteStream = function (file, options) {
      const stream = originalWrite.call(this, file, options);
      if (String(file).startsWith(path.join(cache, 'pending'))) process.nextTick(() => stream.destroy(Object.assign(new Error('Fixture disk full'), { code: 'ENOSPC' })));
      return stream;
    };
    controller.start();
    if (['pause', 'pause-deadline', 'cancel-paused', 'cancel-retry', 'cancel-before-headers', 'cancel-map'].includes(name)) {
      await until(() => records.some(r => name === 'cancel-map' ? r.path.endsWith('.blockmap') : r.range));
      if (!['cancel-before-headers', 'cancel-map'].includes(name)) {
        controller.pause();
        await sleep(60);
        const received = control.receivedBytes();
        await sleep(200);
        assert.equal(control.receivedBytes(), received, 'Paused transport kept consuming bytes');
        assert.equal(installed, 0);
        assert.equal(controller.status().state, 'paused');
      }
      if (name.startsWith('cancel')) controller.cancel();
      else controller.resume();
    }
    try { await controller.wait(); }
    finally { nativeFs.createWriteStream = originalWrite; }
    await until(() => open === 0);
    assert.equal(control.networkActive(), false);
    if (name.startsWith('cancel')) {
      assert.equal(controller.status().state, 'cancelled'); assert.equal(installed, 0); assert.equal(stopped, 0);
      assert.ok(!records.some(r => !r.range && !r.path.endsWith('.blockmap')), 'Cancellation started a full download');
      assert.deepEqual(await fs.readdir(path.join(cache, 'pending')), []);
      if (name === 'cancel-retry') {
        scenario = 'differential'; records = [];
        controller.start(); await controller.wait();
        await until(() => open === 0);
        assert.equal(controller.status().state, 'installing', logs.join('\n'));
        assert.equal(installed, 1); assert.equal(stopped, 1);
        assert.deepEqual(await fs.readFile(path.join(cache, 'pending', filename)), newBytes);
        assert.ok(records.some(r => r.range));
        assert.ok(!records.some(r => !r.range && !r.path.endsWith('.blockmap')));
      }
    } else if (['corrupt-all', 'publisher-rejected', 'disk-full'].includes(name)) {
      assert.equal(controller.status().state, 'failed'); assert.equal(installed, 0); assert.equal(stopped, 0);
      assert.deepEqual(await fs.readdir(path.join(cache, 'pending')), []);
    } else {
      assert.equal(controller.status().state, 'installing', `${name}: ${logs.join('\n')}`);
      assert.equal(installed, 1); assert.equal(stopped, 1);
      assert.deepEqual(await fs.readFile(path.join(cache, 'pending', filename)), newBytes);
      const payload = records.filter(r => !r.path.endsWith('.blockmap'));
      const full = payload.filter(r => !r.range && r.bytes === newBytes.length);
      const expectFull = settings.full || ['missing-cache', 'corrupt-cache', 'missing-map', 'corrupt-map', 'invalid-map', 'oversized-map', 'trickle-map', 'ignore-range', 'wrong-range',
        'reject-range', 'stalled-range', 'stalled-map', 'truncated-range', 'corrupt-range', 'route-fallback'].includes(name);
      assert.equal(full.length, expectFull ? 1 : 0, `${name}: unexpected full transfer`);
      if (!expectFull) {
        assert.ok(payload.some(r => r.range));
        const transferred = payload.reduce((sum, r) => sum + r.bytes, 0);
        assert.ok(transferred < newBytes.length / 2, 'Differential path did not reduce transfer');
        assert.ok(!logs.some(line => line.includes('fallback to full download')), logs.join('\n'));
      }
      if (name === 'cached-map') assert.ok(!records.some(r => r.path.includes('2026.1105.0')));
      if (name === 'route-fallback') assert.ok(!payload.filter(r => !r.path.startsWith('/bad/')).some(r => r.range));
      if (platform === 'darwin' && !updater.disableDifferentialDownload) assert.deepEqual(await fs.readFile(oldFile), newBytes);
    }
    console.log(`PASS ${platform} ${name}`);
  }
  for (const name of ['differential', 'cached-map', 'corrupt-cached-map', 'corrupt-pending-cache', 'missing-cache', 'corrupt-cache', 'missing-map', 'corrupt-map',
    'ignore-range', 'wrong-range', 'reject-range', 'truncated-range', 'corrupt-range', 'stalled-map', 'stalled-range', 'redirect',
    'chunked-range', 'pause', 'pause-deadline', 'cancel-paused', 'cancel-retry', 'cancel-before-headers', 'cancel-map', 'corrupt-all', 'publisher-rejected',
    'invalid-map', 'oversized-map', 'trickle-map', 'disk-full', 'route-fallback']) await run(name);
  await run('legacy-manifest', 'win32', { release: { differentialUpdates: undefined }, full: true });
  await run('release-disabled', 'win32', { release: { differentialUpdates: false }, full: true });
  await run('local-disabled', 'win32', { controller: { disableDifferentialUpdates: true }, full: true });
  const previousDisable = process.env.PILOTDECK_DISABLE_DIFFERENTIAL_UPDATES;
  try { process.env.PILOTDECK_DISABLE_DIFFERENTIAL_UPDATES = '1'; await run('environment-disabled', 'win32', { full: true }); }
  finally {
    if (previousDisable === undefined) delete process.env.PILOTDECK_DISABLE_DIFFERENTIAL_UPDATES;
    else process.env.PILOTDECK_DISABLE_DIFFERENTIAL_UPDATES = previousDisable;
  }
  await run('differential', 'darwin');
  await run('missing-cache', 'darwin');
  await run('corrupt-cache', 'darwin');
  console.log(`Passed ${count} real updater scenarios; native install/signature acceptance is a separate platform gate.`);
})().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  clearTimeout(timeout);
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  if (root) {
    try { await fs.rm(root, { recursive: true, force: true }); }
    catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(error.code)) { console.error(error); code = 1; } }
  }
  app.exit(code);
}
