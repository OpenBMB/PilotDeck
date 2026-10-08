// Windows integration checks against the real decoder and compiled helper.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { prepareWindowsInstaller } = require('./prepare-windows-installer.cjs');

function inventory(root, prefix = '') {
  const result = {};
  for (const item of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, item.name);
    if (item.isDirectory()) Object.assign(result, inventory(root, name));
    else result[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
  }
  return result;
}

(async () => {
  if (process.platform !== 'win32') throw new Error('Run installer integration checks on Windows.');
  const { output } = await prepareWindowsInstaller();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-payload-test-'));
  try {
    const source = path.join(root, 'source files 中文');
    fs.mkdirSync(path.join(source, 'resources', 'git'), { recursive: true });
    fs.mkdirSync(path.join(source, 'resources', 'node'), { recursive: true });
    fs.writeFileSync(path.join(source, 'app.exe'), crypto.randomBytes(4096));
    fs.writeFileSync(path.join(source, 'resources', 'node', 'node.exe'), crypto.randomBytes(16384));
    for (let i = 0; i < 250; i++) fs.writeFileSync(path.join(source, 'resources', 'git', `文件-${i}.txt`), `component ${i}`);
    const archive = path.join(root, 'application.7z');
    const decoder = path.join(output, '7za.exe'), helper = path.join(output, 'install-payload.exe');
    execFileSync(decoder, ['a', '-t7z', '-mx=5', archive, '.'], { cwd: source, windowsHide: true, stdio: 'pipe' });
    const target = path.join(root, 'installed files 中文');
    const install = archivePath => spawnSync(helper, [decoder, archivePath, target, '0', 'en'], { windowsHide: true, encoding: 'utf8', timeout: 60_000 });
    for (const label of ['fresh install', 'replacement install']) {
      const result = install(archive);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(inventory(target), inventory(source), `${label} must preserve every component byte for byte`);
      assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.pilotdeck-install-')), 'clean staging directory');
    }
    const corrupt = path.join(root, 'corrupt.7z');
    const bytes = fs.readFileSync(archive);
    fs.writeFileSync(corrupt, bytes.subarray(0, Math.floor(bytes.length / 2)));
    assert.notEqual(install(corrupt).status, 0, 'corrupt archive must fail');
    assert.deepEqual(inventory(target), inventory(source), 'failed extraction must not alter installed files');
    assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.pilotdeck-install-')), 'clean failed extraction');

    const state = path.join(root, 'payload.state');
    const prepare = () => spawnSync(helper, [decoder, archive, target, '0', 'en', state], { windowsHide: true, encoding: 'utf8' });
    const original = inventory(target);
    assert.equal(prepare().status, 0);
    assert.deepEqual(inventory(target), original, 'preparation never touches the old version');
    assert.ok(fs.existsSync(state), 'prepared payload recorded');
    assert.equal(spawnSync(helper, ['--discard', state], { windowsHide: true }).status, 0);
    assert.deepEqual(inventory(target), original, 'discard preserves old version');
    assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.pilotdeck-install-')));
    fs.writeFileSync(state + '.cancel', 'cancel');
    assert.equal(prepare().status, 1223, 'cancel before extraction returns ERROR_CANCELLED');
    assert.deepEqual(inventory(target), original);
    fs.unlinkSync(state + '.cancel');
    assert.equal(prepare().status, 0);
    const staged = fs.readFileSync(state, 'utf8').split(/\r?\n/)[0];
    fs.rmSync(path.join(staged, 'payload'), { recursive: true });
    fs.mkdirSync(path.join(staged, 'payload'));
    assert.equal(spawnSync(helper, ['--commit', state, '0', 'en'], { windowsHide: true }).status, 1);
    assert.ok(fs.existsSync(path.join(staged, 'install-error.log')), 'failed commit leaves diagnostic and staged directory');
    assert.deepEqual(inventory(target), original, 'failed commit does not change installed files');
    assert.equal(spawnSync(helper, ['--discard', state], { windowsHide: true }).status, 0);
    assert.equal(prepare().status, 0);
    assert.equal(spawnSync(helper, ['--commit', state, '0', 'en'], { windowsHide: true }).status, 0);
    assert.deepEqual(inventory(target), inventory(source));
    assert.ok(!fs.existsSync(state));
    assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.pilotdeck-install-')));

    const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const tests = path.join(root, 'transaction-tests.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', '/main:InstallerTests', `/out:${tests}`,
      path.join(__dirname, '..', 'resources', 'installer', 'InstallPayload.cs'),
      path.join(__dirname, 'installer-transaction-tests.cs')], { windowsHide: true, stdio: 'pipe' });
    execFileSync(tests, [path.join(root, 'transaction')], { windowsHide: true, stdio: 'inherit' });
    console.log('PASS: fresh/replacement installs, Unicode paths, all 252 files preserved, corrupted archive rejected');
  } finally {
    // root is the absolute directory returned by mkdtemp above, never a user path.
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
