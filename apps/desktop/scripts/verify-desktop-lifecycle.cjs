// Runs the real Electron main process against an isolated, tiny HTTP runtime.
// Native dialogs are answered by the fixture; no real user data or tasks are used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Run this check on Windows or macOS.');
async function verify(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-tray-test-'));
  try {
    const desktop = path.resolve(__dirname, '..');
    const runtime = path.join(root, 'runtime');
    const utils = path.join(runtime, 'ui', 'server', 'utils');
    fs.mkdirSync(utils, { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'));
    fs.mkdirSync(path.join(root, 'resources', 'icons'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pilotdeck-tray-test', version: '1.0.0', main: 'fixture.cjs' }));
    fs.writeFileSync(path.join(runtime, 'package.json'), '{"type":"module"}');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'desktop-lifecycle.cjs'), path.join(root, 'fixture.cjs'));
    for (const name of ['icon.ico', 'icon.png', 'trayTemplate.png', 'trayTemplate@2x.png']) {
      fs.copyFileSync(path.join(desktop, 'resources', 'icons', name), path.join(root, 'resources', 'icons', name));
    }
    for (const file of fs.readdirSync(path.join(desktop, 'src')).filter(name => name.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(desktop, 'src', file), 'utf8');
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
      fs.writeFileSync(path.join(root, 'dist', file.replace(/\.ts$/, '.js')), compiled);
    }
    for (const file of ['processTree.js', 'processIdentity.cjs', 'processScope.cjs', 'processGuardian.cjs', 'processJobHost.cjs', 'processJob.ps1']) {
      fs.copyFileSync(path.resolve(desktop, '../../ui/server/utils', file), path.join(utils, file));
    }
    const treeFile = path.join(utils, 'processTree.js');
    fs.writeFileSync(treeFile, fs.readFileSync(treeFile, 'utf8').replace(
      'export const spawnManaged = scopes.spawnManaged;',
      `export const spawnManaged = (...args) => {
        const child = scopes.spawnManaged(...args);
        writeFileSync(process.env.PILOTDECK_TEST_SCOPES, JSON.stringify(child[scopes.KEY]) + '\\n', {flag:'a'});
        return child;
      };`));
    fs.writeFileSync(path.join(runtime, 'ui', 'server', 'index.js'), `
      import http from 'node:http';
      import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      fs.writeFileSync(process.env.PILOTDECK_TRAY_TEST_PID, String(process.pid));
      const task = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
      fs.writeFileSync(process.env.PILOTDECK_TRAY_TEST_PID + '.task', String(task.pid));
      if (process.env.PILOTDECK_TEST_SCENARIO === 'startup-quit') await new Promise(resolve => setTimeout(resolve, 700));
      process.send({type:'pilotdeck:configuration-state',configuration:{state:'ready'}});
      http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Tray test</title><p>Isolated runtime</p>'); }).listen(Number(process.env.SERVER_PORT), '127.0.0.1');
    `);
    fs.mkdirSync(path.join(runtime, 'dist', 'src', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'dist', 'src', 'cli', 'pilotdeck.js'), `
      import net from 'node:net';
      import fs from 'node:fs';
      fs.writeFileSync(process.env.PILOTDECK_TRAY_TEST_PID + '.gateway', String(process.pid));
      net.createServer(socket => socket.end()).listen(Number(process.env.PILOTDECK_GATEWAY_PORT), '127.0.0.1');
    `);
    fs.mkdirSync(path.join(runtime, 'ui', 'server', 'services'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'ui', 'server', 'services', 'releaseService.js'),
      'export const normalizeRepository = value => value; export const compareVersions = () => 0;');
    const env = {
      ...process.env,
      PILOTDECK_TRAY_TEST_UPDATER: path.dirname(require.resolve('electron-updater/package.json')),
      PILOTDECK_DESKTOP_RUNTIME_ROOT: runtime,
      PILOTDECK_DESKTOP_NODE: process.execPath,
      PILOT_HOME: path.join(root, 'home'),
      PILOTDECK_CONFIG_DIR: path.join(root, 'home'),
      PILOTDECK_CONFIG_PATH: path.join(root, 'home', 'config.json'),
      PILOTDECK_TRAY_TEST_PID: path.join(root, 'runtime.pid'),
      PILOTDECK_TEST_SCENARIO: scenario,
      PILOTDECK_TEST_SCOPES: path.join(root, 'scopes.jsonl'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PILOTDECK_DESKTOP_GIT_ROOT;
    // This is the GUI under test, not a background helper. STARTUPINFO/SW_HIDE
    // from windowsHide can suppress its first native ShowWindow call, including
    // an explicit tray restore after closing a show:false startup window.
    const result = spawnSync(require('electron'), [root], { env, windowsHide: false, encoding: 'utf8', timeout: scenario === 'manual' ? 300_000 : 120_000, killSignal: 'SIGKILL' });
    const step = path.join(root, 'step');
    assert.equal(result.status, 0, `${scenario}: ${fs.existsSync(step) ? fs.readFileSync(step, 'utf8') : 'before first checkpoint'}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.ok(fs.existsSync(path.join(root, 'passed')), 'real app reached graceful shutdown');
    console.log(`PASS: ${process.platform} Electron lifecycle — ${scenario}`);
  } finally {
    // Also clean up owned process trees if an assertion or Electron itself failed.
    // Keep the fixture files available until its process guardians have stopped.
    const { stopProcessTree } = await import('../../../ui/server/utils/processTree.js');
    const records = path.join(root, 'scopes.jsonl');
    if (fs.existsSync(records)) {
      for (const scope of fs.readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).reverse()) {
        if (fs.existsSync(scope.directory)) await stopProcessTree({}, {scope}).catch(error => console.error('Fixture cleanup:', error.message));
      }
    }
    // Only the absolute directory allocated above; never the real app profile.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}
(async () => {
  const scenarios = process.argv.slice(2);
  for (const scenario of scenarios.length ? scenarios : ['normal', 'slow-quit', 'startup-quit', 'stop-failure', 'update', 'update-recovery', ...(process.platform === 'darwin' ? ['shutdown'] : [])]) {
    await verify(scenario);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
