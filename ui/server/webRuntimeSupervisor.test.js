import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeSupervisor,
  getRuntimeCommands,
  normalizeSupervisorMode,
} from './webRuntimeSupervisor.js';

function createFakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.connected = true;
  child.send = vi.fn();
  child.kill = vi.fn((signal) => {
    child.killed = true;
    child.killedSignal = signal;
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
    env: { PILOTDECK_GATEWAY_PORT: '18789' },
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
  it('starts the UI server first and Vite only in development', () => {
    expect(normalizeSupervisorMode('anything')).toBe('start-built');
    expect(getRuntimeCommands('start-built').map(({ name }) => name)).toEqual(['server', 'gateway']);
    expect(getRuntimeCommands('dev').map(({ name }) => name)).toEqual(['server', 'client', 'gateway']);

    const built = createHarness();
    expect(built.spawnImpl).toHaveBeenCalledTimes(1);
    expect(built.supervisor.children.has('server')).toBe(true);
    expect(built.supervisor.children.has('gateway')).toBe(false);

    const dev = createHarness({ mode: 'dev' });
    expect(dev.spawnImpl).toHaveBeenCalledTimes(2);
    expect(dev.supervisor.children.has('server')).toBe(true);
    expect(dev.supervisor.children.has('client')).toBe(true);
  });

  it('starts Gateway once after ready configuration and reports readiness', async () => {
    const { supervisor, spawnImpl } = createHarness();
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
    await vi.waitFor(() => {
      expect(server.send).toHaveBeenLastCalledWith({
        type: 'pilotdeck:gateway-state',
        state: 'ready',
      });
    });
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

  it('exits the runtime when the UI server exits without a restart request', () => {
    const { supervisor, exit } = createHarness();
    supervisor.children.get('server').emit('close', 1, null);

    expect(exit).toHaveBeenCalledWith(1);
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

  it('restarts the server and client after a supervised update request', () => {
    const { supervisor, spawnImpl, exit } = createHarness({
      mode: 'dev',
      requestExists: true,
    });
    const server = supervisor.children.get('server');
    server.emit('close', 42, null);

    expect(spawnImpl).toHaveBeenCalledTimes(4);
    expect(exit).not.toHaveBeenCalled();
    expect(supervisor.children.has('server')).toBe(true);
    expect(supervisor.children.has('client')).toBe(true);
  });

  it('stops all managed processes on SIGINT', () => {
    const processLike = createFakeProcess();
    const children = [createFakeChild(), createFakeChild()];
    const exit = vi.fn();
    createRuntimeSupervisor({
      mode: 'dev',
      spawnImpl: vi.fn(() => children.shift()),
      waitForPortImpl: vi.fn(async () => undefined),
      exists: () => false,
      processLike,
      exit,
      log: vi.fn(),
      error: vi.fn(),
    }).run();

    processLike.emitSignal('SIGINT');

    expect(exit).toHaveBeenCalledWith(0);
  });
});
