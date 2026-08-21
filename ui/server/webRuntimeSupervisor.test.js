import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeSupervisor,
  getRuntimeArgs,
  normalizeSupervisorMode,
} from './webRuntimeSupervisor.js';

function createFakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn((signal) => {
    child.killed = true;
    child.killedSignal = signal;
  });
  return child;
}

function createFakeProcess() {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
    }),
    emitSignal(signal) {
      handlers.get(signal)?.();
    },
  };
}

describe('web runtime supervisor', () => {
  it('normalizes unknown modes to start-built', () => {
    expect(normalizeSupervisorMode('dev')).toBe('dev');
    expect(normalizeSupervisorMode('anything')).toBe('start-built');
    expect(getRuntimeArgs('dev')).toContain('npm:dev:client');
    expect(getRuntimeArgs('start-built')).toContain('npm:server');
  });

  it('exits without restart when the child exits normally and no request exists', () => {
    const child = createFakeChild();
    const spawnImpl = vi.fn(() => child);
    const exit = vi.fn();

    createRuntimeSupervisor({
      mode: 'start-built',
      spawnImpl,
      exists: () => false,
      unlink: vi.fn(),
      processLike: createFakeProcess(),
      exit,
      log: vi.fn(),
      error: vi.fn(),
    }).run();

    child.emit('close', 0, null);

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('restarts once when the request file exists', () => {
    const firstChild = createFakeChild();
    const secondChild = createFakeChild();
    const spawnImpl = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const unlink = vi.fn();
    const exists = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const exit = vi.fn();

    createRuntimeSupervisor({
      mode: 'start-built',
      spawnImpl,
      exists,
      unlink,
      processLike: createFakeProcess(),
      exit,
      log: vi.fn(),
      error: vi.fn(),
    }).run();

    firstChild.emit('close', 1, null);
    secondChild.emit('close', 0, null);

    expect(unlink).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forwards SIGINT and does not restart on signal shutdown', () => {
    const child = createFakeChild();
    const spawnImpl = vi.fn(() => child);
    const processLike = createFakeProcess();
    const exit = vi.fn();

    createRuntimeSupervisor({
      mode: 'dev',
      spawnImpl,
      exists: () => true,
      unlink: vi.fn(),
      processLike,
      exit,
      log: vi.fn(),
      error: vi.fn(),
    }).run();

    processLike.emitSignal('SIGINT');
    child.emit('close', null, 'SIGINT');

    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
