import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';

const mod = { exports: {} };
new Function('module', 'exports', 'require', ts.transpileModule(fs.readFileSync(new URL('../src/runtimeEnvironment.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText)(mod, mod.exports, createRequire(import.meta.url));
const { desktopInstallationRoot, withRuntimeCommandPath } = mod.exports;

for (const [platform, resources, expected] of [
  ['win32', 'C:\\Program Files\\PilotDeck\\resources', 'C:\\Program Files\\PilotDeck'],
  ['darwin', '/Applications/PilotDeck.app/Contents/Resources', '/Applications/PilotDeck.app'],
  ['linux', '/opt/PilotDeck/resources', '/opt/PilotDeck'],
]) test(`protect the complete packaged ${platform} installation`, () => {
  assert.equal(desktopInstallationRoot(resources, platform), expected);
});

test('Windows duplicate keys retain Node selection while bundled tools win command lookup', () => {
  const env = Object.freeze({ Path: 'wrong-lower', PATH: 'existing-upper', path: 'wrong-last', TEMP: 'chosen-temp', Temp: 'wrong-temp' });
  const git = { bash: 'C:\\App 中文\\git\\bin\\bash.exe', git: 'C:\\App 中文\\git\\cmd\\git.exe', pathEntries: ['C:\\App 中文\\git\\cmd'] };
  const next = withRuntimeCommandPath(env, 'C:\\App 中文\\runtime', 'C:\\App 中文\\node\\node.exe', git, { platform: 'win32' });
  assert.deepEqual(Object.keys(next).filter(key => key.toUpperCase() === 'PATH'), ['PATH']);
  assert.equal(next.PATH, 'C:\\App 中文\\node;C:\\App 中文\\git\\cmd;C:\\App 中文\\runtime\\node_modules\\.bin;existing-upper');
  assert.equal(next.TEMP, 'chosen-temp');
  assert.equal(next.Temp, undefined);
  assert.equal(next.PILOTDECK_GIT_BASH_PATH, git.bash);
  assert.equal(next.PILOTDECK_BUNDLED_GIT, '1');
  assert.equal(env.Path, 'wrong-lower');
});

for (const platform of ['win32', 'darwin', 'linux']) test(`packaged ${platform} runtime ignores inherited preloads but keeps proxy and CA settings`, () => {
  const env = { NODE_OPTIONS: '--require=missing-hook.cjs', NODE_PATH: '/stale-modules', ELECTRON_RUN_AS_NODE: '1',
    NODE_EXTRA_CA_CERTS: '/corporate-ca.pem', HTTPS_PROXY: 'http://proxy.test:8080', API_KEY: 'fixture-key' };
  const next = withRuntimeCommandPath(env, '/app/runtime', '/app/node', undefined, { platform, packaged: true });
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) assert.equal(next[key], undefined);
  for (const key of ['NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'API_KEY']) assert.equal(next[key], env[key]);
});

test('source development keeps explicit Node flags and case-sensitive Unix variables', () => {
  const next = withRuntimeCommandPath({ PATH: '/usr/bin', Path: 'distinct-unix-value', NODE_OPTIONS: '--trace-warnings' }, '/app', '/node/bin/node', undefined, { platform: 'linux' });
  assert.equal(next.PATH, '/node/bin:/app/node_modules/.bin:/usr/bin');
  assert.equal(next.Path, 'distinct-unix-value');
  assert.equal(next.NODE_OPTIONS, '--trace-warnings');
});

test('an unset uppercase override does not erase a defined Windows Path', () => {
  const next = withRuntimeCommandPath({ PATH: undefined, Path: 'C:\\Windows\\System32' }, 'C:\\App', 'C:\\App\\node.exe', undefined, { platform: 'win32' });
  assert.equal(next.Path, 'C:\\App;C:\\App\\node_modules\\.bin;C:\\Windows\\System32');
  assert.equal('PATH' in next, false);
});

test('real Windows runtime starts from a Unicode/spaced path despite stale PATH and a failing preload', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-env-'));
  try {
    const directory = path.join(root, '用户 with spaces & (test)');
    fs.mkdirSync(directory);
    const node = path.join(directory, 'node.exe');
    fs.copyFileSync(process.execPath, node);
    const env = withRuntimeCommandPath({ ...process.env, Path: 'C:\\missing-lower', PATH: 'C:\\missing-upper', NODE_OPTIONS: '--require=missing-hook.cjs' }, directory, node, undefined, { packaged: true });
    const result = spawnSync('node', ['-e', 'console.log(JSON.stringify({execPath:process.execPath,hook:process.env.NODE_OPTIONS}))'], { env, cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.deepEqual(JSON.parse(result.stdout), { execPath: node });
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
