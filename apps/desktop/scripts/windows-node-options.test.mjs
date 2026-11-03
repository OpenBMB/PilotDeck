import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('packaged Electron reaches app startup despite an unsupported global NODE_OPTIONS', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-electron-env-'));
  try {
    // Never flip the developer's shared Electron distribution.
    const source = fs.realpathSync(require('electron'));
    const distribution = path.join(root, 'Electron 测试 with spaces');
    await fs.promises.cp(path.dirname(source), distribution, { recursive: true });
    const executable = path.join(distribution, path.basename(source));
    assert.ok(fs.existsSync(executable), 'isolated Electron distribution was copied');
    const appDirectory = path.join(root, '启动应用 & (profile)');
    fs.mkdirSync(path.join(appDirectory, 'profile'), { recursive: true });
    fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'pilotdeck-startup-test', main: 'main.cjs' }));
    const marker = path.join(root, 'started.json');
    fs.writeFileSync(path.join(appDirectory, 'main.cjs'), `
      const { app } = require('electron');
      const fs = require('node:fs'), path = require('node:path');
      app.disableHardwareAcceleration();
      app.setPath('userData', path.join(__dirname, 'profile'));
      app.whenReady().then(() => { fs.writeFileSync(process.env.PILOTDECK_BOOT_TEST_MARKER, JSON.stringify({ started: true })); app.quit(); });
    `);
    const env = { ...process.env, NODE_OPTIONS: '--pilotdeck-invalid-startup-option', PILOTDECK_BOOT_TEST_MARKER: marker };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = () => spawnSync(executable, [appDirectory], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const before = launch();
    assert.notEqual(before.status, 0, 'baseline Electron should reject the inherited invalid Node flag');
    assert.equal(fs.existsSync(marker), false);
    const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } = createRequire(require.resolve('electron-builder'))('@electron/fuses');
    const configuration = require('../package.json').build.electronFuses;
    await flipFuses(executable, { version: FuseVersion.V1,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: configuration.enableNodeOptionsEnvironmentVariable });
    const wire = await getCurrentFuseWire(executable);
    assert.equal(String.fromCharCode(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable]), '0');
    const after = launch();
    assert.equal(after.status, 0, after.stderr || String(after.error));
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { started: true });
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
