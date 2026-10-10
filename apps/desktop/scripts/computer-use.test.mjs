import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { selectDriverAsset, verifyDriverArchive } from './download-cua-driver.mjs';

const require = createRequire(import.meta.url);
const fixture = fileURLToPath(new URL('fixtures/computer-use-driver.cjs', import.meta.url));
const execute = promisify(execFile);
const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/computerUse.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function setup({ permissions = true, bundleId = 'cn.pilotdeck.desktop', permissionApplication = false } = {}) {
  const originalDisplay = process.env.DISPLAY;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) process.env.DISPLAY = ':fixture';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cua-test-'));
  const resources = path.join(root, 'resources');
  fs.mkdirSync(resources);
  const binary = path.join(resources, process.platform === 'darwin' ? 'PilotDeck Computer Use.app/Contents/MacOS/cua-driver' : process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.copyFileSync(new URL('fixtures/computer-use-driver.cjs', import.meta.url), binary);
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(path.join(resources, 'manifest.json'), JSON.stringify({ version: '0.34.1' }));
  const pidFile = path.join(root, 'driver.pid');
  const permissionAppPath = permissionApplication ? path.join(root, 'PilotDeck.app') : undefined;
  if (permissionAppPath) fs.mkdirSync(permissionAppPath);
  let reveals = 0;
  // Run the fixture with Node on every OS, including Windows where a script
  // named .exe is not executable. Keep real child processes, native sockets /
  // named pipes, stdin shutdown and exit events in the controller tests.
  const fixtureArgs = args => [fixture, '--pid-file', pidFile, ...args];
  const fixtureExecFile = (file, args, options, callback) => {
    assert.equal(file, binary);
    return execFile(process.execPath, fixtureArgs(args), options, callback);
  };
  fixtureExecFile[promisify.custom] = (file, args, options) => {
    assert.equal(file, binary);
    return execute(process.execPath, fixtureArgs(args), options);
  };
  const fixtureRequire = id => id === 'node:child_process' ? {
    execFile: fixtureExecFile,
    spawn: (file, args, options) => {
      assert.equal(file, binary);
      return spawn(process.execPath, fixtureArgs(args), options);
    },
  } : require(id);
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, fixtureRequire);
  const controller = new mod.exports.ComputerUseController({ directory: path.join(root, 'settings'), resources, bundleId,
    permissions: () => ({ accessibility: permissions, screenRecording: permissions }), requestPermission: async () => {},
    permissionAppPath, revealPermissionApp: () => { reveals++; }, log: () => {} });
  const servers = () => JSON.parse(fs.readFileSync(controller.mcpConfigPath, 'utf8')).mcpServers;
  return { root, resources, controller, servers, permissionAppPath, pidFile, reveals: () => reveals, cleanup: async () => {
    await controller.stop(); fs.rmSync(root, { recursive: true, force: true });
    if (originalDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = originalDisplay;
  } };
}
function canConnect(endpoint) {
  return new Promise(resolve => {
    const socket = net.createConnection(endpoint);
    const finish = connected => { socket.destroy(); resolve(connected); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
test('published Driver assets cover exactly the six existing OS/CPU targets', () => {
  for (const platform of ['darwin', 'win32', 'linux']) for (const arch of ['x64', 'arm64']) {
    assert.match(selectDriverAsset(platform, arch).sha256, /^[0-9a-f]{64}$/);
  }
  assert.throws(() => selectDriverAsset('linux', 'ia32'), /Unsupported/);
  assert.throws(() => verifyDriverArchive(Buffer.from('corrupt'), selectDriverAsset('linux', 'x64')), /checksum mismatch/);
});
test('reveals the outer desktop permission owner without starting its nested Driver', {skip: process.platform !== 'darwin'}, async () => {
  const f = setup({ permissions: false, permissionApplication: true });
  try {
    assert.equal(f.controller.status().permissionAppPath, f.permissionAppPath);
    assert.equal((await f.controller.revealPermissionApp()).enabled, false);
    assert.equal(f.reveals(), 1); assert.deepEqual(f.servers(), {});
    fs.rmdirSync(f.permissionAppPath);
    await assert.rejects(f.controller.revealPermissionApp(), /unavailable/);
    assert.equal(f.reveals(), 1);
  } finally { await f.cleanup(); }
});
test('starts disabled, gates missing OS grants, and rejects untyped renderer input', async () => {
  const f = setup({ permissions: false });
  try {
    assert.equal((await f.controller.initialize()).phase, 'disabled');
    assert.deepEqual(f.servers(), {});
    assert.equal((await f.controller.setEnabled(true)).phase, 'needs-permissions');
    assert.deepEqual(f.servers(), {});
    await assert.rejects(f.controller.setEnabled('true'), /boolean/);
    await assert.rejects(f.controller.requestPermission('other'), /Invalid permission/);
  } finally { await f.cleanup(); }
});
test('publishes a private connection only after startup and removes it on disable', async () => {
  const f = setup();
  try {
    const enabled = await f.controller.setEnabled(true);
    assert.equal(enabled.phase, 'ready');
    const spec = f.servers()['pilotdeck-computer-use'];
    const endpoint = spec.args[spec.args.indexOf('--socket') + 1];
    assert.equal(await canConnect(endpoint), true);
    if (process.platform === 'win32') assert.match(endpoint, /^\\\\\.\\pipe\\pilotdeck-cua-/);
    const pid = Number(fs.readFileSync(f.pidFile, 'utf8'));
    assert.equal(isAlive(pid), true);
    assert.equal(spec.concurrencySafe, false);
    assert.equal(spec.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, 'false');
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.controller.mcpConfigPath).mode & 0o777, 0o600);
    assert.equal((await f.controller.setEnabled(false)).phase, 'disabled');
    assert.deepEqual(f.servers(), {});
    assert.equal(await canConnect(endpoint), false);
    assert.equal(isAlive(pid), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'settings', 'settings.json'))).enabled, false);
  } finally { await f.cleanup(); }
});
test('a crashed Driver loses its connection and manual reconnect uses a fresh generation', async () => {
  const f = setup();
  try {
    await f.controller.setEnabled(true);
    const spec = f.servers()['pilotdeck-computer-use'];
    const endpoint = spec.args[spec.args.indexOf('--socket') + 1];
    const pid = Number(fs.readFileSync(f.pidFile, 'utf8'));
    process.kill(pid, 'SIGKILL');
    const deadline = Date.now() + 3000;
    while (f.controller.status().phase !== 'error' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.controller.status().phase, 'error');
    assert.deepEqual(f.servers(), {});
    assert.equal(isAlive(pid), false);
    assert.equal(await canConnect(endpoint), false);
    assert.equal((await f.controller.refresh()).phase, 'ready');
    assert.notEqual(f.servers()['pilotdeck-computer-use'].args[3], endpoint);
    assert.equal(await canConnect(f.servers()['pilotdeck-computer-use'].args[3]), true);
    assert.notEqual(Number(fs.readFileSync(f.pidFile, 'utf8')), pid);
  } finally { await f.cleanup(); }
});
test('shutdown preserves the preference but revokes the running connection', async () => {
  const f = setup();
  try {
    await f.controller.setEnabled(true);
    const endpoint = f.servers()['pilotdeck-computer-use'].args[3];
    const pid = Number(fs.readFileSync(f.pidFile, 'utf8'));
    await f.controller.stop();
    assert.deepEqual(f.servers(), {});
    assert.equal(await canConnect(endpoint), false);
    assert.equal(isAlive(pid), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'settings', 'settings.json'))).enabled, true);
  } finally { await f.cleanup(); }
});
test('rejects a daemon with a different macOS permission owner', { skip: process.platform !== 'darwin' }, async () => {
  const f = setup({ bundleId: 'wrong.host' });
  try {
    assert.equal((await f.controller.setEnabled(true)).phase, 'error');
    assert.deepEqual(f.servers(), {});
  } finally { await f.cleanup(); }
});
