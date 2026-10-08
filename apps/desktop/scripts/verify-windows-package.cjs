// Run with the bundled Node.js inside the packaged Windows application.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { executableArchitecture } = require('./windows-architecture.cjs');

const appRoot = path.resolve(process.argv[2]);
const expectedArch = process.argv[3];
const resources = path.join(appRoot, 'resources');
assert.equal(process.platform, 'win32');
assert.equal(process.arch, expectedArch);
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(resources, 'node/node.exe')));
assert.ok(fs.statSync(path.join(resources, 'app.asar')).size > 0);
for (const file of ['PilotDeck.exe', 'resources/node/node.exe', 'resources/git/cmd/git.exe']) {
  assert.equal(executableArchitecture(path.join(appRoot, file)), expectedArch, file);
}
assert.match(execFileSync(path.join(resources, 'git/cmd/git.exe'), ['--version'], { encoding: 'utf8', timeout: 30_000 }), /git version/);
// Portable Git's MSYS Bash may run through Windows x64 emulation on ARM64.
assert.match(execFileSync(path.join(resources, 'git/bin/bash.exe'), ['--noprofile', '--norc', '-c', 'printf pilotdeck-bash-ok'], { encoding: 'utf8', timeout: 30_000 }), /pilotdeck-bash-ok/);

const runtimeRequire = createRequire(path.join(resources, 'runtime/package.json'));
const Database = runtimeRequire('better-sqlite3');
const db = new Database(':memory:');
try { assert.equal(db.prepare('SELECT 42 AS value').get().value, 42); }
finally { db.close(); }
const bcrypt = runtimeRequire('bcrypt');
assert.equal(bcrypt.compareSync('windows-smoke', bcrypt.hashSync('windows-smoke', 4)), true);

async function main() {
  const runtime = path.join(resources, 'runtime');
  const installer = path.join(runtime, 'scripts/install-asr.mjs');
  assert.ok(fs.statSync(installer).size > 0, 'packaged FunASR installer must be present');
  const asr = await import(pathToFileURL(installer).href);
  assert.equal(typeof asr.installRuntime, 'function');
  const previousRoot = process.env.PILOTDECK_RUNTIME_ROOT;
  try {
    process.env.PILOTDECK_RUNTIME_ROOT = runtime;
    const { getPilotDeckInstallCommand } = await import(pathToFileURL(path.join(runtime, 'dist/src/mcp/runtime/projectMcpSpec.js')).href);
    const command = getPilotDeckInstallCommand();
    assert.ok(command.includes(process.execPath));
    assert.ok(command.includes(installer));
    assert.ok(!command.startsWith('npm '), 'desktop ASR installation uses bundled Node');
  } finally {
    if (previousRoot === undefined) delete process.env.PILOTDECK_RUNTIME_ROOT;
    else process.env.PILOTDECK_RUNTIME_ROOT = previousRoot;
  }
  const { resolveRuntimeAsset } = await import(pathToFileURL(path.join(runtime, 'dist/src/extension/plugins/builtin/funasr/funasr-runtime.mjs')).href);
  assert.equal(resolveRuntimeAsset().key, 'win32-x64');
  const sharp = runtimeRequire('sharp');
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer();
  assert.equal((await sharp(image).metadata()).width, 2);
  const pty = runtimeRequire('node-pty');
  const child = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo pilotdeck-pty-ok'], {
    name: 'xterm', cols: 80, rows: 24, cwd: appRoot, env: process.env,
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('PTY smoke timed out')); }, 10_000);
    child.onData(chunk => { output += chunk; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0) resolve(); else reject(new Error(`PTY exited with ${exitCode}`));
    });
  });
  assert.match(output, /pilotdeck-pty-ok/);
  console.log(`PASS: Windows ${expectedArch} packaged Electron, Node, Git, Bash and native modules`);
}
// ConPTY's native worker can keep Node alive after the terminal has exited.
// All assertions and cleanup have finished here; explicitly return the result to CI.
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
