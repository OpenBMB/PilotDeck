#!/usr/bin/env node
// Reproducible, isolated compiled-runtime benchmark. Never reads the real profile
// or calls a model. Pass another compiled checkout with --root for comparison.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = path.resolve(option('--root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const samples = Number(option('--samples', '3'));
if (!Number.isInteger(samples) || samples < 1 || samples > 20) throw new Error('Use 1–20 samples.');
if (!fs.existsSync(path.join(root, 'dist/src/cli/pilotdeck.js'))) throw new Error('Compile the checkout first.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-benchmark-'));
const runtime = path.join(temporary, 'runtime');
function copy(from, to) { fs.cpSync(path.join(root, from), path.join(runtime, to || from), { recursive: true, filter: file => !/\.(?:db|sqlite)(?:-wal|-shm)?$/i.test(file) }); }
function link(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir'); }
function rewrite(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rewrite(file);
    else if (entry.name.endsWith('.js')) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('../../src/', '../../dist/src/').replaceAll('../../../src/', '../../../dist/src/'));
  }
}
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
try {
  copy('dist/src'); copy('src/extension/plugins/builtin', 'dist/src/extension/plugins/builtin');
  copy('ui/server'); copy('ui/shared'); copy('ui/public'); copy('scripts/check-node-runtime.mjs'); copy('scripts/computer-use'); copy('scripts/lib');
  if (fs.existsSync(path.join(root, 'resources/cua-driver'))) copy('resources/cua-driver');
  fs.writeFileSync(path.join(runtime, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(runtime, 'ui/package.json'), '{"type":"module"}\n');
  link(fs.realpathSync(path.join(root, 'node_modules')), path.join(runtime, 'node_modules'));
  link(fs.realpathSync(path.join(root, 'ui/node_modules')), path.join(runtime, 'ui/node_modules'));
  if (fs.existsSync(path.join(root, 'ui/dist'))) link(path.join(root, 'ui/dist'), path.join(runtime, 'ui/dist'));
  rewrite(path.join(runtime, 'ui/server'));
  // Match desktop packaging: the native helper is precompiled, not charged on
  // every application launch. The first profile ACL/migration remains measured.
  const nativeModule = path.join(root, 'ui/server/utils/nativeProcessHost.cjs');
  if (process.platform === 'win32' && fs.existsSync(nativeModule)) {
    const helper = require(nativeModule).nativeProcessHost();
    if (helper) fs.copyFileSync(helper, path.join(runtime, 'ui/server/utils', path.basename(helper)));
  }
  const { spawnManaged, stopProcessTree } = await import(pathToFileURL(path.join(runtime, 'ui/server/utils/processTree.js')));
  const home = path.join(temporary, 'profile'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'pilotdeck.yaml'), 'schemaVersion: 1\nagent:\n  model: test/one\nmodel:\n  providers:\n    test:\n      protocol: openai\n      url: http://127.0.0.1:1/v1\n      apiKey: benchmark-no-network\n      models:\n        one: {}\ntelemetry:\n  enabled: false\n');
  const results = [];
  for (let sample = 0; sample < samples; sample++) {
    const serverPort = await port(), gatewayPort = await port(), children = [];
    const env = { ...process.env, PILOT_HOME: home, HOME: home, PILOTDECK_CONFIG_PATH: path.join(home, 'pilotdeck.yaml'), DATABASE_PATH: path.join(home, 'auth.db'), HOST: '127.0.0.1',
      SERVER_PORT: String(serverPort), PILOTDECK_GATEWAY_PORT: String(gatewayPort), PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/ws`,
      PILOTDECK_RUNTIME_ROOT: runtime, PILOTDECK_DESKTOP_RUNTIME_ROOT: runtime, PILOTDECK_DESKTOP: '1', PILOTDECK_DISABLE_LOCAL_AUTH: '1', PILOTDECK_RUNTIME_SUPERVISED: '1', PILOTDECK_SKIP_BROWSER_OPEN: '1', PILOTDECK_SKIP_DEFAULT_PROJECT: '1', ANALYTICS_ENABLED: 'false' };
    delete env.NODE_OPTIONS; delete env.PILOTDECK_NATIVE_PROCESS_HOST;
    const start = performance.now();
    function launch(entry, cwd, commandArgs, readyType) {
      const child = spawnManaged(process.execPath, [entry, ...commandArgs], { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); children.push(child);
      let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-5000); });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 120_000);
        child.on('message', message => { if (message?.type === readyType) { clearTimeout(timer); resolve(child); } });
        child.once('managed-exit', (code, signal, failure) => { clearTimeout(timer); reject(new Error(`Startup exited ${code}/${signal}: ${failure || output}`)); });
        child.once('error', reject);
      });
    }
    try {
      await launch(path.join(runtime, 'ui/server/index.js'), path.join(runtime, 'ui'), [], 'pilotdeck:server-ready');
      const webMs = Math.round(performance.now() - start);
      await launch(path.join(runtime, 'dist/src/cli/pilotdeck.js'), runtime, ['server'], 'pilotdeck:gateway-ready');
      const row = { sample, profile: sample === 0 ? 'first-start' : 'existing', webMs, totalMs: Math.round(performance.now() - start) };
      results.push(row); console.log(JSON.stringify(row));
    } finally { for (const child of children.reverse()) await stopProcessTree(child); }
  }
  const summary = { root, node: process.version, platform: `${process.platform}-${process.arch}`, samples: results };
  const output = option('--output'); if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(summary, null, 2) + '\n');
} finally {
  // This absolute directory is created by mkdtemp above and is never supplied by
  // a caller. Junction cleanup removes only the junctions, never their targets.
  fs.rmSync(temporary, { recursive: true, force: true });
}
