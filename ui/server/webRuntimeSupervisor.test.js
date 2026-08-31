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

  it('restarts the runtime in the same supervisor when the request file exists', () => {
    const firstChild = createFakeChild();
    const secondChild = createFakeChild();
    const spawnImpl = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const unlink = vi.fn();
    const exists = vi.fn().mockReturnValueOnce(true);
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

    expect(unlink).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(spawnImpl).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      getRuntimeArgs('start-built'),
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({
          PILOTDECK_RESTART_MODE: 'start-built',
          PILOTDECK_RESTART_SUPERVISOR: '1',
        }),
      }),
    );
    expect(exit).not.toHaveBeenCalled();

    secondChild.emit('close', 0, null);

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('can restart the runtime repeatedly without spawning nested supervisors', () => {
    const firstChild = createFakeChild();
    const secondChild = createFakeChild();
    const thirdChild = createFakeChild();
    const spawnImpl = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValueOnce(thirdChild);
    const exists = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const exit = vi.fn();

    createRuntimeSupervisor({
      mode: 'start-built',
      spawnImpl,
      exists,
      unlink: vi.fn(),
      processLike: createFakeProcess(),
      exit,
      log: vi.fn(),
      error: vi.fn(),
    }).run();

    firstChild.emit('close', 1, null);
    secondChild.emit('close', 1, null);
    thirdChild.emit('close', 0, null);

    expect(spawnImpl).toHaveBeenCalledTimes(3);
    for (const call of spawnImpl.mock.calls) {
      expect(call[1]).toEqual(getRuntimeArgs('start-built'));
    }
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits without restarting when the restart request cannot be consumed', () => {
    const child = createFakeChild();
    const spawnImpl = vi.fn().mockReturnValueOnce(child);
    const unlink = vi.fn(() => {
      throw new Error('permission denied');
    });
    const exit = vi.fn();
    const error = vi.fn();

    createRuntimeSupervisor({
      mode: 'start-built',
      spawnImpl,
      exists: () => true,
      unlink,
      processLike: createFakeProcess(),
      exit,
      log: vi.fn(),
      error,
    }).run();

    child.emit('close', 1, null);
    child.emit('close', 1, null);

    expect(unlink).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to consume restart request'));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits with failure when the restarted runtime cannot be started', () => {
    const child = createFakeChild();
    const spawnImpl = vi.fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(createFakeChild());
    const exit = vi.fn();
    const error = vi.fn();

    createRuntimeSupervisor({
      mode: 'start-built',
      spawnImpl,
      exists: () => true,
      unlink: vi.fn(),
      processLike: createFakeProcess(),
      exit,
      log: vi.fn(),
      error,
    }).run();

    child.emit('close', 1, null);
    spawnImpl.mock.results[1].value.emit('error', new Error('spawn failed'));

    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to start runtime'));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
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
