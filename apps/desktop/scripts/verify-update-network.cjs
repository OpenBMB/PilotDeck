// Run with Electron after desktop compile. No windows or external network access.
// Exercises the actual discovery fetch and electron-updater download executor.
const { app } = require('electron');
const { MacUpdater, NsisUpdater } = require('electron-updater');
const { createUpdateNetwork } = require('../dist/updateNetwork.js');
const { getLatestRelease } = require('../../../ui/server/services/releaseService.js');
const { createServer } = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-network-test-'));
app.setPath('userData', path.join(root, 'electron'));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const guard = setTimeout(() => { console.error('Network regression test timed out'); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  const payload = Buffer.from('verified update payload');
  const sha512 = createHash('sha512').update(payload).digest('base64');
  const asset = { name: 'PilotDeck-test.zip', platform: 'darwin', arch: 'arm64', size: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'), sha512 };
  const manifest = { schemaVersion: 1, repository: 'fixture/PilotDeck', tag: 'v2026.09.07', version: '2026.907.0', sourceSha: 'a'.repeat(40), assets: [asset] };
  const requests = [];
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=pilotdeck-update-fixture'], { stdio: 'ignore' });
  const origin = https.createServer({ key: fs.readFileSync(path.join(root, 'key.pem')), cert: fs.readFileSync(path.join(root, 'cert.pem')) }, (req, res) => {
    requests.push(req.url);
    if (req.url.includes('/repos/')) res.end(JSON.stringify([{ tag_name: manifest.tag, assets: [{ name: 'release.json' }, asset] }]));
    else if (req.url.endsWith('/release.json')) res.end(JSON.stringify(manifest));
    else { res.setHeader('Content-Length', payload.length); res.end(payload); }
  });
  await listen(origin);
  const tunnels = new Set();
  const destinations = [];
  let requireAuth = false;
  const proxy = createServer((_req, res) => { res.writeHead(502); res.end(); });
  proxy.on('connect', (req, socket, head) => {
    if (requireAuth && req.headers['proxy-authorization'] !== `Basic ${Buffer.from('user:password').toString('base64')}`) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    destinations.push(req.url);
    assert.ok(['api.github.com:443', 'github.com:443'].includes(req.url));
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    for (const stream of [socket, upstream]) { tunnels.add(stream); stream.on('error', () => {}); stream.on('close', () => tunnels.delete(stream)); }
  });
  await listen(proxy);
  const updater = process.platform === 'win32' ? new NsisUpdater() : new MacUpdater();
  updater.netSession.setCertificateVerifyProc((request, callback) => callback(['api.github.com', 'github.com'].includes(request.hostname) ? 0 : -3));
  let activeNetwork;
  updater.on('login', (auth, callback) => {
    const credentials = activeNetwork.credentialsFor(auth);
    callback(credentials?.username || '', credentials?.password || '');
  });
  try {
    for (const source of ['env', 'config', 'authenticated-config']) {
      requests.length = 0; destinations.length = 0;
      requireAuth = source === 'authenticated-config';
      await updater.netSession.clearAuthCache();
      const proxyUrl = `http://${requireAuth ? 'user:password@' : ''}127.0.0.1:${proxy.address().port}`;
      const network = createUpdateNetwork(updater.netSession, () => source !== 'env' ? { url: proxyUrl } : undefined,
        source === 'env' ? { PILOTDECK_PROXY: proxyUrl } : {});
      activeNetwork = network;
      await network.prepare();
      assert.equal(await updater.netSession.resolveProxy('http://127.0.0.1:1234'), 'DIRECT');
      const release = await getLatestRelease({ repository: manifest.repository, fetchImpl: network.fetch, env: {} });
      assert.equal(release.version, manifest.version);
      // The real updater download transport, including its separate net.request path.
      const cancellationToken = { createPromise: executor => new Promise((resolve, reject) => executor(resolve, reject, () => {})) };
      const destination = path.join(root, `${source}.zip`);
      await updater.httpExecutor.download(new URL(release.assets[0].downloadUrl), destination, { cancellationToken, sha512 });
      assert.deepEqual(fs.readFileSync(destination), payload);
      assert.equal(requests.length, 3);
      assert.ok(destinations.includes('api.github.com:443'));
      assert.ok(destinations.includes('github.com:443'));
      console.log(`PASS: ${source} proxy routes release list, manifest and updater payload; loopback bypasses proxy`);
    }
  } finally {
    await updater.netSession.closeAllConnections();
    for (const socket of tunnels) socket.destroy();
    await close(proxy); await close(origin);
  }
}).then(() => { clearTimeout(guard); fs.rmSync(root, { recursive: true, force: true }); app.exit(0); })
  .catch(error => { console.error(error); fs.rmSync(root, { recursive: true, force: true }); app.exit(1); });
