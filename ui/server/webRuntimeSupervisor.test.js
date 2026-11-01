import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
// Native loading preserves the CLI shebang; Vitest's Windows VM transform does not.
const { resolveLaunchConfigPath } = createRequire(import.meta.url)('../../scripts/dev-launcher.mjs');
const {
  createRuntimeSupervisor,
  getRuntimeCommands,
  normalizeSupervisorMode,
} = createRequire(import.meta.url)('./webRuntimeSupervisor.js');

function createFakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.connected = true;
  child.send = vi.fn();
  child.kill = vi.fn((signal) => {
    child.killed = true;
    child.killedSignal = signal;
    queueMicrotask(() => child.emit('close', null, signal));
  });
  return child;
}

function createFakeProcess() {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    emitSignal(signal) {
      handlers.get(signal)?.();
    },
  };
}

function createHarness({
  mode = 'start-built',
  requestExists = false,
  waitForPortImpl = vi.fn(async () => undefined),
  env = {},
} = {}) {
  const spawned = [];
  const spawnImpl = vi.fn(() => {
    const child = createFakeChild();
    spawned.push(child);
    return child;
  });
  const exit = vi.fn();
  const supervisor = createRuntimeSupervisor({
    mode,
    env: { PILOTDECK_GATEWAY_PORT: '18789', ...env },
    spawnImpl,
    waitForPortImpl,
    exists: () => requestExists,
    unlink: vi.fn(),
    processLike: createFakeProcess(),
    exit,
    log: vi.fn(),
    error: vi.fn(),
  });
  supervisor.run();
  return { supervisor, spawnImpl, spawned, exit };
}

describe('web runtime supervisor', () => {
  it('starts the shared packaged runtime with built JavaScript and no source or tsx dependency', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runtime-commands-'));
    try {
      fs.mkdirSync(path.join(root, 'dist/src/cli'), { recursive: true });
      fs.writeFileSync(path.join(root, 'dist/src/cli/pilotdeck.js'), '');
      const commands = getRuntimeCommands('start-built', path.join(root, 'ui'));
      expect(commands[0].args).toEqual([path.join(root, 'ui/server/index.js')]);
      expect(commands[1].args).toEqual([path.join(root, 'dist/src/cli/pilotdeck.js'), 'server']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('starts the UI server first and Vite only in development', () => {
    expect(normalizeSupervisorMode('anything')).toBe('start-built');
    expect(getRuntimeCommands('start-built').map(({ name }) => name)).toEqual(['server', 'gateway']);
    expect(getRuntimeCommands('dev').map(({ name }) => name)).toEqual(['server', 'client', 'gateway']);

    const built = createHarness();
    expect(built.spawnImpl).toHaveBeenCalledTimes(1);
    expect(built.supervisor.children.has('server')).toBe(true);
    expect(built.supervisor.children.has('gateway')).toBe(false);

    const dev = createHarness({ mode: 'dev' });
    expect(dev.spawnImpl).toHaveBeenCalledTimes(1);
    expect(dev.supervisor.children.has('server')).toBe(true);
    expect(dev.supervisor.children.has('client')).toBe(false);
    dev.supervisor.children.get('server').emit('message', { type: 'pilotdeck:server-ready', port: 0 });
    expect(dev.spawnImpl).toHaveBeenCalledTimes(1);
    dev.supervisor.children.get('server').emit('message', { type: 'pilotdeck:server-ready', port: 3002 });
    expect(dev.supervisor.children.has('client')).toBe(true);
    expect(dev.spawnImpl.mock.calls[1][2].env.SERVER_PORT).toBe('3002');
    dev.supervisor.children.get('server').emit('message', { type: 'pilotdeck:server-ready', port: 3002 });
    expect(dev.spawnImpl).toHaveBeenCalledTimes(2);
  });

  it('passes one absolute config path to the UI server and Gateway', () => {
    const relativeConfigPath = 'fixtures/pilotdeck.yaml';
    const { supervisor, spawnImpl } = createHarness({
      env: { PILOTDECK_CONFIG_PATH: relativeConfigPath },
    });
    const server = supervisor.children.get('server');
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'ready', revision: 'one' },
    });

    const expectedPath = path.resolve(relativeConfigPath);
    expect(spawnImpl.mock.calls[0][2].env.PILOTDECK_CONFIG_PATH).toBe(expectedPath);
    expect(spawnImpl.mock.calls[1][2].env.PILOTDECK_CONFIG_PATH).toBe(expectedPath);
  });

  it('resolves a dev config path before changing to the repository root', () => {
    const launchCwd = path.join(process.cwd(), 'nested', 'ui');
    expect(resolveLaunchConfigPath('../custom.yaml', launchCwd)).toBe(
      path.resolve(launchCwd, '../custom.yaml'),
    );
  });

  it('keeps Gateway stopped while configuration is missing', () => {
    const { supervisor, spawnImpl } = createHarness();
    const server = supervisor.children.get('server');

    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'needs_configuration', reason: 'missing_config' },
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(supervisor.children.has('server')).toBe(true);
    expect(supervisor.children.has('gateway')).toBe(false);
  });

  it.each([80, 18789])('starts Gateway once and reports readiness on port %i', async port => {
    const { supervisor, spawnImpl } = createHarness({ env: { PILOTDECK_GATEWAY_PORT: String(port) } });
    const server = supervisor.children.get('server');
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'ready', revision: 'one' },
    });
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'ready', revision: 'one' },
    });

    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(spawnImpl.mock.calls[1][2].stdio).toContain('ipc');
    supervisor.children.get('gateway').emit('message', { type: 'pilotdeck:gateway-ready', port });
    await vi.waitFor(() => {
      expect(server.send).toHaveBeenLastCalledWith({
        type: 'pilotdeck:gateway-state',
        state: 'ready',
      });
    });
  });

  it('does not treat an occupied port as readiness before its own Gateway starts', async () => {
    const { supervisor } = createHarness();
    const server = supervisor.children.get('server');
    server.emit('message', { type: 'pilotdeck:configuration-state', configuration: { state: 'ready' } });
    await Promise.resolve();
    expect(server.send).toHaveBeenLastCalledWith({ type: 'pilotdeck:gateway-state', state: 'starting' });
    const gateway = supervisor.children.get('gateway');
    gateway.emit('message', { type: 'pilotdeck:gateway-ready', port: 18790 });
    expect(server.send).toHaveBeenLastCalledWith({ type: 'pilotdeck:gateway-state', state: 'starting' });
    gateway.emit('close', 1, null);
    gateway.emit('message', { type: 'pilotdeck:gateway-ready', port: 18789 });
    expect(server.send).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error' }));
    expect(server.send.mock.calls.some(([message]) => message.state === 'ready')).toBe(false);
  });

  it('waits for the port check as well as the child readiness message', async () => {
    let finishPort;
    const { supervisor } = createHarness({ waitForPortImpl: () => new Promise(resolve => { finishPort = resolve; }) });
    const server = supervisor.children.get('server');
    server.emit('message', { type: 'pilotdeck:configuration-state', configuration: { state: 'ready' } });
    supervisor.children.get('gateway').emit('message', { type: 'pilotdeck:gateway-ready', port: 18789 });
    expect(server.send).toHaveBeenLastCalledWith({ type: 'pilotdeck:gateway-state', state: 'starting' });
    finishPort();
    await vi.waitFor(() => expect(server.send).toHaveBeenLastCalledWith({ type: 'pilotdeck:gateway-state', state: 'ready' }));
  });

  it('times out if an occupied port is open but the managed Gateway never reports ready', async () => {
    vi.useFakeTimers();
    try {
      const { supervisor } = createHarness();
      const server = supervisor.children.get('server');
      server.emit('message', { type: 'pilotdeck:configuration-state', configuration: { state: 'ready' } });
      const gateway = supervisor.children.get('gateway');
      await vi.advanceTimersByTimeAsync(90_000);
      expect(gateway.kill).toHaveBeenCalled();
      expect(server.send).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error', error: expect.stringContaining('Timed out') }));
    } finally { vi.useRealTimers(); }
  });

  it('keeps the UI server alive when Gateway exits', () => {
    const { supervisor, exit } = createHarness();
    const server = supervisor.children.get('server');
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'ready', revision: 'one' },
    });
    const gateway = supervisor.children.get('gateway');
    gateway.emit('close', 1, null);

    expect(supervisor.children.has('server')).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(server.send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'pilotdeck:gateway-state',
      state: 'error',
    }));
  });

  it('reports a Gateway readiness failure without exiting the UI', async () => {
    const { supervisor, exit } = createHarness({
      waitForPortImpl: vi.fn(async () => {
        throw new Error('gateway timeout');
      }),
    });
    const server = supervisor.children.get('server');
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'ready', revision: 'one' },
    });

    await vi.waitFor(() => {
      expect(server.send).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'pilotdeck:gateway-state',
        state: 'error',
        error: 'gateway timeout',
      }));
    });
    expect(supervisor.children.has('server')).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits the runtime when the UI server exits without a restart request', async () => {
    const { supervisor, exit } = createHarness();
    supervisor.children.get('server').emit('close', 1, null);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('retries Gateway without duplicating it', () => {
    const { supervisor, spawnImpl } = createHarness();
    const server = supervisor.children.get('server');
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'ready', revision: 'one' },
    });
    const firstGateway = supervisor.children.get('gateway');
    firstGateway.emit('close', 1, null);
    server.emit('message', { type: 'pilotdeck:retry-gateway' });

    expect(spawnImpl).toHaveBeenCalledTimes(3);
    expect(supervisor.children.get('gateway')).not.toBe(firstGateway);
  });

  it('stops Gateway when configuration is no longer ready', () => {
    const { supervisor } = createHarness();
    const server = supervisor.children.get('server');
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'ready', revision: 'one' },
    });
    const gateway = supervisor.children.get('gateway');
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'invalid', revision: 'two' },
    });

    expect(gateway.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.children.has('gateway')).toBe(false);
    expect(server.send).toHaveBeenLastCalledWith({
      type: 'pilotdeck:gateway-state',
      state: 'stopped',
    });
  });

  it('waits for a stopped Gateway before starting it again', async () => {
    const { supervisor, spawnImpl } = createHarness();
    const server = supervisor.children.get('server');
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'ready', revision: 'one' },
    });
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'invalid', revision: 'two' },
    });
    server.emit('message', {
      type: 'pilotdeck:configuration-state',
      configuration: { state: 'ready', revision: 'three' },
    });

    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(3));
  });

  it('restarts the server and client after a supervised update request', async () => {
    const { supervisor, spawnImpl, exit } = createHarness({
      mode: 'dev',
      requestExists: true,
    });
    const server = supervisor.children.get('server');
    server.emit('message', { type: 'pilotdeck:server-ready', port: 3002 });
    server.emit('close', 42, null);

    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(3));
    supervisor.children.get('server').emit('message', { type: 'pilotdeck:server-ready', port: 3003 });
    expect(spawnImpl).toHaveBeenCalledTimes(4);
    expect(exit).not.toHaveBeenCalled();
    expect(supervisor.children.has('server')).toBe(true);
    expect(supervisor.children.has('client')).toBe(true);
  });

  it('stops all managed processes on SIGINT', async () => {
    const processLike = createFakeProcess();
    const children = [createFakeChild(), createFakeChild()];
    const exit = vi.fn();
    const supervisor = createRuntimeSupervisor({
      mode: 'dev',
      spawnImpl: vi.fn(() => children.shift()),
      waitForPortImpl: vi.fn(async () => undefined),
      exists: () => false,
      processLike,
      exit,
      log: vi.fn(),
      error: vi.fn(),
    });
    supervisor.run();
    supervisor.children.get('server').emit('message', { type: 'pilotdeck:server-ready', port: 3002 });

    processLike.emitSignal('SIGINT');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
