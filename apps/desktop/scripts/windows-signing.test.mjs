import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import signing from './windows-signing.cjs';

const { loadSigningConfig, applySigningConfig, isOwnedExecutable } = signing;
const sha = 'A'.repeat(40);
const env = { PILOTDECK_WINDOWS_CERT_SHA1: sha, PILOTDECK_WINDOWS_PUBLISHER: 'Example Publisher', SIGNTOOL_PATH: process.execPath };

test('hosted signing probe compiles the real helper from an unrelated Unicode working directory', { skip: process.platform !== 'win32' }, () => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const { parse } = createRequire(new URL('../../../package.json', import.meta.url))('yaml');
  const workflow = parse(fs.readFileSync(path.join(repository, '.github/workflows/windows-signing-check.yml'), 'utf8'));
  const step = workflow.jobs.sign.steps.find(step => step.name === 'Compile the project installer helper as a signing fixture');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-signing-测试 '));
  try {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', step.run], {
      cwd: directory, env: { ...process.env, GITHUB_WORKSPACE: repository, RUNNER_TEMP: directory },
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const fixture = fs.readFileSync(path.join(directory, 'pilotdeck-signing-check.exe'));
    assert.equal(fixture.subarray(0, 2).toString(), 'MZ');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Windows store config does not affect Linux/macOS or unsigned CI builds', () => {
  assert.equal(loadSigningConfig(env, 'linux'), null);
  assert.equal(loadSigningConfig(env, 'darwin'), null);
  assert.equal(loadSigningConfig({ ...env, PILOTDECK_WINDOWS_SIGNING: 'off' }, 'win32'), null);
  assert.equal(loadSigningConfig({}, 'win32'), null);
});

test('required signing rejects missing or malformed certificate, publisher and tool', () => {
  assert.throws(() => loadSigningConfig({ PILOTDECK_WINDOWS_SIGNING: 'required' }, 'win32'), /thumbprint/);
  assert.throws(() => loadSigningConfig({ ...env, PILOTDECK_WINDOWS_CERT_SHA1: 'bogus' }, 'win32'), /thumbprint/);
  assert.throws(() => loadSigningConfig({ ...env, PILOTDECK_WINDOWS_PUBLISHER: '' }, 'win32'), /publisher/);
  assert.throws(() => loadSigningConfig({ ...env, SIGNTOOL_PATH: 'signtool.exe' }, 'win32'), /absolute path/);
  assert.throws(() => loadSigningConfig({ ...env, PILOTDECK_WINDOWS_TIMESTAMP_URL: 'file:///tmp/x' }, 'win32'), /HTTP/);
  assert.throws(() => loadSigningConfig({ ...env, PILOTDECK_WINDOWS_SIGNING: 'false' }, 'win32'), /auto, required or off/);
});

test('machine-local config auto-enables signing, accepts BOM and explicit env overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-signing-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ certificateSha1: sha.toLowerCase(), publisherName: 'Local Publisher', signToolPath: process.execPath }));
    const localEnv = { PILOTDECK_WINDOWS_SIGNING_CONFIG: file };
    assert.equal(loadSigningConfig(localEnv, 'win32').certificateSha1, sha);
    assert.equal(loadSigningConfig(localEnv, 'win32').publisherName, 'Local Publisher');
    assert.equal(loadSigningConfig({ ...localEnv, ...env }, 'win32').publisherName, 'Example Publisher');
    fs.writeFileSync(file, '{}');
    assert.throws(() => loadSigningConfig(localEnv, 'win32'), /thumbprint/);
    assert.throws(() => loadSigningConfig({ ...localEnv, PILOTDECK_WINDOWS_SIGNING: 'required' }, 'win32'), /thumbprint/);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => loadSigningConfig(localEnv, 'win32'), SyntaxError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cloud backend requires an explicit tool and keeps credentials out of config', () => {
  assert.throws(() => loadSigningConfig({ ...env, PILOTDECK_WINDOWS_SIGNING_PROVIDER: 'ssign' }, 'win32'), /PILOTDECK_SSIGN_PATH/);
  const cloud = loadSigningConfig({ ...env, PILOTDECK_WINDOWS_SIGNING_PROVIDER: 'ssign', PILOTDECK_SSIGN_PATH: process.execPath, CERTUM_OTP: 'sensitive-value' }, 'win32');
  assert.equal(cloud.provider, 'ssign');
  assert.ok(!JSON.stringify(cloud).includes('sensitive-value'));
  assert.throws(() => loadSigningConfig({ ...env, PILOTDECK_WINDOWS_SIGNING_PROVIDER: 'unknown' }, 'win32'), /provider/);
});

test('only app, own helper, setup/portable and generated NSIS uninstaller are signed', () => {
  for (const file of ['PilotDeck.exe', 'install-payload.exe', 'PilotDeck-2026.1028.3-win-x64-setup.exe',
    'PilotDeck-2026.1028.3-win-arm64-setup.__uninstaller.exe', 'PilotDeck-2026.1028.3-win-x64-portable.exe']) {
    assert.equal(isOwnedExecutable(path.join('output', file)), true, file);
  }
  for (const file of ['node.exe', 'git.exe', '7za.exe', 'elevate.exe', 'chrome_crashpad_handler.exe', 'PilotDeck.exe.bak']) {
    assert.equal(isOwnedExecutable(path.join('output', file)), false, file);
  }
});

test('signed builder config requires signatures, publishes expected updater identity and retains base targets', () => {
  const base = { win: { target: ['nsis'], icon: 'icon.ico' }, nsis: { include: 'installer.nsh' } };
  const result = applySigningConfig(base, loadSigningConfig(env, 'win32'));
  assert.equal(result.forceCodeSigning, true);
  assert.equal(result.win.verifyUpdateCodeSignature, true);
  assert.equal(result.win.signtoolOptions.publisherName, 'Example Publisher');
  assert.deepEqual(result.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
  assert.deepEqual(result.win.target, ['nsis']);
  assert.equal(result.nsis, base.nsis);
  assert.equal(base.forceCodeSigning, undefined);
  assert.equal(applySigningConfig(base, null), base);
});
