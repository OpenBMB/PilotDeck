// Run with the Node.js binary inside an installed PilotDeck DEB or RPM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const installRoot = '/opt/PilotDeck';
const resources = path.join(installRoot, 'resources');
const runtime = path.join(resources, 'runtime');
const expectedArch = process.argv[2];
const packageType = process.argv[3] || "deb";
assert.ok(["deb", "rpm"].includes(packageType));
assert.equal(process.platform, 'linux');
assert.equal(process.arch, expectedArch);
assert.equal(execFileSync('ps', ['-p', String(process.pid), '-o', 'pid='], {
  encoding: 'utf8', timeout: 5000,
}).trim(), String(process.pid), 'process management requires ps from the package dependencies');
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(resources, 'node/bin/node')));
assert.equal(fs.readFileSync(path.join(resources, 'package-type'), 'utf8').trim(), packageType);
assert.ok(fs.statSync(path.join(resources, 'app.asar')).size > 0);
const iconPath = '/usr/share/icons/hicolor/256x256/apps/pilotdeck-desktop.png';
const launcherPath = '/usr/share/applications/pilotdeck-desktop.desktop';
assert.ok(fs.statSync(iconPath).size > 0);
assert.ok(fs.statSync(iconPath).mode & 0o004, 'installed icon must be readable by desktop users');
assert.ok(fs.statSync(launcherPath).mode & 0o004, 'desktop launcher must be readable by desktop users');
assert.match(fs.readFileSync(launcherPath, 'utf8'), /^Icon=pilotdeck-desktop$/m);

const runtimeRequire = createRequire(path.join(runtime, 'package.json'));
const Database = runtimeRequire('better-sqlite3');
const db = new Database(':memory:');
try {
  assert.equal(db.prepare('SELECT 42 AS value').get().value, 42);
} finally {
  db.close();
}

const bcrypt = runtimeRequire('bcrypt');
const hash = bcrypt.hashSync('linux-smoke', 4);
assert.equal(bcrypt.compareSync('linux-smoke', hash), true);

async function verifyPty() {
  const pty = runtimeRequire('node-pty');
  const child = pty.spawn('/bin/sh', ['-c', 'printf pilotdeck-pty-ok'], {
    name: 'xterm', cols: 80, rows: 24, cwd: '/tmp', env: process.env,
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('PTY smoke timed out')); }, 10_000);
    child.onData(chunk => { output += chunk; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0) resolve();
      else reject(new Error(`PTY exited with ${exitCode}`));
    });
  });
  assert.match(output, /pilotdeck-pty-ok/);
}

async function main() {
  const sharp = runtimeRequire('sharp');
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } })
    .png().toBuffer();
  assert.equal((await sharp(image).metadata()).width, 2);
  await verifyPty();
  console.log(`PASS: installed Linux ${expectedArch} ${packageType.toUpperCase()}, launcher, icon and native modules`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
