import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
// Exercise the real manager and coordinator without importing Electron's
// application entry point, reading a profile or launching user processes.
const managerSource = source.slice(source.indexOf('class RuntimeManager {'), source.indexOf('async function ensureRuntime('));
const coordinatorSource = source.includes('async function stopRuntime(')
  ? source.slice(source.indexOf('async function stopRuntime('), source.indexOf('function isMainWindowForeground('))
  : `async function stopRuntime() {${source.slice(source.indexOf('const lifecycle =')).match(/stopRuntime: async \(\) => \{([\s\S]*?)\n  \},/)[1]}}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ initialize, port, cleanup } = {}) {
  const log = { spawns: [], stops: [], readiness: [], statuses: [], ports: [] };
  const scope = {
    AbortController, DOMException, Error, Promise, Date, path,
    process: { env: {}, platform: 'win32', arch: 'x64', resourcesPath: '/synthetic/resources', stdout: { write() {} } },
    os: { homedir: () => '/synthetic/home', EOL: '\n' },
    fs: { statSync() { throw new Error('No synthetic configuration'); }, existsSync: () => true },
    app: { isPackaged: true, getPath: name => `/synthetic/${name}`, setAppLogsPath() {}, getVersion: () => '0.0.0' },
    APP_ID: 'synthetic.desktop', DEFAULT_UPDATE_REPOSITORY: 'synthetic/repository', PROCESS_LAUNCH_CWD: '/synthetic',
    setRuntimeLogRetention() {}, createRuntimeLogWriter: () => ({ write() {}, close() {} }), rendererLog: undefined,
    publishRuntimeStatus: status => log.statuses.push(status), redactDiagnostic: value => value,
    ensurePilotHome: () => ({ pilotHome: '/synthetic/profile' }),
    resolveBundledGitPaths: () => undefined, resolvePlaywrightBrowsersPath: () => '/synthetic/browsers', readBuildMetadata: () => ({}),
    runtimeReportArguments: () => [],
    desktopInstallationRoot: () => '/synthetic/install', withRuntimeCommandPath: env => env,
    ComputerUseController: class {
      async initialize() { await initialize?.(); }
      async stop() { log.stops.push('computer-use'); await cleanup?.(); }
    },
    async findFreePort(preferred) { log.ports.push(preferred); await port?.(preferred); return preferred; },
    waitForPortOrProcessExit(child, name, _port, _host, _timeout, _log, options = {}) {
      const entry = { child, name, signal: options.signal, release: undefined, reject: undefined };
      log.readiness.push(entry);
      let onAbort;
      return new Promise((resolve, reject) => {
        entry.release = resolve;
        entry.reject = reject;
        onAbort = () => reject(options.signal.reason);
        options.signal?.addEventListener('abort', onAbort, { once: true });
      }).finally(() => options.signal?.removeEventListener('abort', onAbort));
    },
    async killProcessTree(child) { log.stops.push(child.name); await cleanup?.(); child.exitCode = 0; },
    isQuitting: false, runtime: null, runtimeStartPromise: null,
  };
  vm.createContext(scope);
  vm.runInContext(ts.transpileModule(`${managerSource}\n${coordinatorSource}\nglobalThis.Manager = RuntimeManager;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, scope);
  const manager = new scope.Manager('/synthetic/runtime', '/synthetic/node');
  manager.spawnRuntime = function(name) {
    const child = Object.assign(new EventEmitter(), { name, exitCode: null, signalCode: null, connected: false });
    this.processes.push({ name, child });
    log.spawns.push(child);
    return child;
  };
  scope.runtime = manager;
  const start = () => {
    // ensureRuntime uses this same cleanup wrapper around the manager promise.
    const pending = manager.start().catch(async error => { await manager.stop(); throw error; });
    scope.runtimeStartPromise = pending;
    void pending.catch(() => {});
    return pending;
  };
  return { manager, scope, log, start };
}

test('explicit Quit cancels a stalled Web startup before awaiting readiness', async () => {
  const f = fixture();
  const startup = f.start();
  await tick();
  assert.equal(f.log.readiness.length, 1);
  const quitting = f.scope.stopRuntime();
  await tick();
  try {
    assert.ok(f.log.stops.includes('server'), 'Quit must stop the owned server without waiting for its startup timeout');
    assert.equal(f.log.readiness[0].signal.aborted, true);
  } finally {
    // The baseline has no cancellation: release the synthetic gate so a
    // failing differential test still disposes all its fake owned resources.
    for (const pending of f.log.readiness) pending.release();
    await quitting;
    await startup.catch(() => {});
  }
  assert.equal(f.scope.runtime, null);
  assert.equal(f.scope.runtimeStartPromise, null);
  assert.equal(f.log.statuses.some(status => status.phase === 'error'), false);
});

test('a Gateway started before Web readiness is canceled by the same stop', async () => {
  const f = fixture();
  const startup = f.start();
  await tick();
  f.manager.handleServerMessage({ type: 'pilotdeck:configuration-state', configuration: { state: 'ready' } });
  await tick();
  assert.deepEqual(f.log.readiness.map(item => item.name), ['server', 'gateway']);
  await f.scope.stopRuntime();
  await startup.catch(() => {});
  assert.ok(f.log.readiness.every(item => item.signal.aborted));
  assert.deepEqual(f.log.stops, ['computer-use', 'gateway', 'server']);
  assert.equal(f.log.statuses.some(status => status.phase === 'error' || status.phase === 'ready'), false);
});

test('Gateway startup failure cleanup cannot publish an error after shutdown begins', async () => {
  const gate = deferred();
  const f = fixture({ cleanup: () => gate.promise });
  const startup = f.start();
  await tick();
  f.manager.handleServerMessage({ type: 'pilotdeck:configuration-state', configuration: { state: 'ready' } });
  await tick();
  f.log.readiness.find(item => item.name === 'gateway').reject(new Error('synthetic failed startup'));
  await tick();
  const stopping = f.scope.stopRuntime();
  gate.resolve();
  await stopping;
  await startup.catch(() => {});
  assert.equal(f.log.statuses.some(status => status.phase === 'error'), false);
  assert.equal(f.manager.getInfo(), null);
});

test('Web startup failure becomes cancellation if replacement starts during Gateway cleanup', async () => {
  const gate = deferred();
  const f = fixture({ cleanup: () => gate.promise });
  const startup = f.start();
  await tick();
  f.manager.handleServerMessage({ type: 'pilotdeck:configuration-state', configuration: { state: 'ready' } });
  await tick();
  f.log.readiness.find(item => item.name === 'server').reject(new Error('synthetic failed startup'));
  await tick();
  const stopping = f.scope.stopRuntime();
  gate.resolve();
  await stopping;
  await assert.rejects(startup, { name: 'AbortError' });
  assert.equal(f.log.statuses.some(status => status.phase === 'error'), false);
});

test('readiness fulfilled immediately before stop cannot publish a ready runtime', async () => {
  const f = fixture();
  const startup = f.start();
  await tick();
  f.manager.handleServerMessage({ type: 'pilotdeck:configuration-state', configuration: { state: 'ready' } });
  await tick();
  for (const pending of f.log.readiness) pending.release();
  await f.scope.stopRuntime();
  await assert.rejects(startup, { name: 'AbortError' });
  assert.equal(f.log.statuses.some(status => status.phase === 'ready' || status.phase === 'awaiting_configuration'), false);
  assert.equal(f.manager.getInfo(), null);
});

for (const stage of ['computer-use', 'web-port', 'gateway-port']) {
  test(`stop during ${stage} preparation cannot launch a late Web process`, async () => {
    const gate = deferred();
    const f = fixture({
      initialize: stage === 'computer-use' ? () => gate.promise : undefined,
      port: preferred => (stage === 'web-port' && preferred === 3001) || (stage === 'gateway-port' && preferred === 18789)
        ? gate.promise : Promise.resolve(),
    });
    const startup = f.start();
    await tick();
    const stopping = f.scope.stopRuntime();
    gate.resolve();
    await stopping;
    await assert.rejects(startup, { name: 'AbortError' });
    assert.equal(f.log.spawns.length, 0);
    assert.equal(f.log.readiness.length, 0);
  });
}

test('concurrent starts and stops share one launch and cleanup, including completed stop', async () => {
  const gate = deferred();
  const f = fixture({ cleanup: () => gate.promise });
  const first = f.manager.start();
  const second = f.manager.start();
  assert.equal(first, second);
  const canceled = assert.rejects(first, { name: 'AbortError' });
  await tick();
  const stop = f.manager.stop();
  assert.equal(f.manager.stop(), stop);
  gate.resolve();
  await stop;
  await canceled;
  assert.equal(f.manager.stop(), stop);
  assert.deepEqual(f.log.stops, ['computer-use', 'server']);
  assert.equal(f.log.spawns.length, 1);
});

test('failed cleanup retains ownership and can be retried', async () => {
  let fail = true;
  const f = fixture({ cleanup: () => { if (fail) throw new Error('synthetic stop failure'); } });
  const startup = f.manager.start();
  const canceled = assert.rejects(startup, { name: 'AbortError' });
  await tick();
  await assert.rejects(f.manager.stop(), /process records retained/);
  await canceled;
  assert.equal(f.manager.processes.length, 1);
  fail = false;
  await f.manager.stop();
  assert.equal(f.manager.processes.length, 0);
});

test('late stop completion does not clear a replacement runtime or startup promise', async () => {
  const gate = deferred();
  const f = fixture({ cleanup: () => gate.promise });
  const startup = f.start();
  await tick();
  const stopping = f.scope.stopRuntime();
  const replacement = {};
  const replacementStartup = Promise.resolve();
  f.scope.runtime = replacement;
  f.scope.runtimeStartPromise = replacementStartup;
  gate.resolve();
  await stopping;
  await startup.catch(() => {});
  assert.equal(f.scope.runtime, replacement);
  assert.equal(f.scope.runtimeStartPromise, replacementStartup);
});

test('normal readiness still produces one runtime and cleans up on stop', async () => {
  const f = fixture();
  const startup = f.start();
  await tick();
  f.log.readiness[0].release();
  const info = await startup;
  assert.equal(info.serverPort, 3001);
  assert.equal(info.gatewayPort, 18789);
  assert.equal(f.manager.getInfo(), info);
  await f.scope.stopRuntime();
  assert.equal(f.manager.getInfo(), null);
  assert.deepEqual(f.log.stops, ['computer-use', 'server']);
});
