import express from 'express';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createUpdateRouter } from './update.js';
import { RESTART_EXIT_CODE } from '../services/updateRuntime.js';

const nativeFetch = globalThis.fetch;

function createApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/update', router);
  return app;
}

async function requestJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      ...init,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('update restart route', () => {
  const instanceInfo = {
    instanceId: 'old-instance',
    startedAt: '2026-08-24T04:00:00.000Z',
    pid: 12345,
  };

  it('accepts supervisor restarts after writing the request file', async () => {
    const requestSupervisorRestartImpl = vi.fn();
    const setTimeoutImpl = vi.fn();
    const exit = vi.fn();
    const app = createApp(createUpdateRouter({
      env: {
        PILOTDECK_RESTART_SUPERVISOR: '1',
        PILOTDECK_RESTART_REQUEST_FILE: '/tmp/pilotdeck/restart.json',
      },
      requestSupervisorRestartImpl,
      setTimeoutImpl,
      exit,
      getInstanceInfo: () => instanceInfo,
      log: vi.fn(),
      error: vi.fn(),
    }));

    const response = await requestJson(app, '/api/update/restart', { method: 'POST' });

    expect(response).toEqual({
      status: 202,
      body: {
        status: 'accepted',
        restartMode: 'supervisor',
        previousInstanceId: 'old-instance',
        previousStartedAt: '2026-08-24T04:00:00.000Z',
        previousPid: 12345,
      },
    });
    expect(requestSupervisorRestartImpl).toHaveBeenCalledTimes(1);
    expect(setTimeoutImpl).toHaveBeenCalledWith(expect.any(Function), 500);
    setTimeoutImpl.mock.calls[0][0]();
    expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE);
  });

  it('accepts docker restarts with previous instance metadata', async () => {
    const setTimeoutImpl = vi.fn();
    const exit = vi.fn();
    const app = createApp(createUpdateRouter({
      env: { DOCKER: '1' },
      setTimeoutImpl,
      exit,
      getInstanceInfo: () => instanceInfo,
      log: vi.fn(),
      error: vi.fn(),
    }));

    const response = await requestJson(app, '/api/update/restart', { method: 'POST' });

    expect(response).toEqual({
      status: 202,
      body: {
        status: 'accepted',
        restartMode: 'docker',
        previousInstanceId: 'old-instance',
        previousStartedAt: '2026-08-24T04:00:00.000Z',
        previousPid: 12345,
      },
    });
    setTimeoutImpl.mock.calls[0][0]();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('returns 500 when supervisor request file writing fails', async () => {
    const requestSupervisorRestartImpl = vi.fn(() => {
      throw new Error('permission denied');
    });
    const setTimeoutImpl = vi.fn();
    const app = createApp(createUpdateRouter({
      env: {
        PILOTDECK_RESTART_SUPERVISOR: '1',
        PILOTDECK_RESTART_REQUEST_FILE: '/tmp/pilotdeck/restart.json',
      },
      requestSupervisorRestartImpl,
      setTimeoutImpl,
      log: vi.fn(),
      error: vi.fn(),
    }));

    const response = await requestJson(app, '/api/update/restart', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('permission denied');
    expect(setTimeoutImpl).not.toHaveBeenCalled();
  });

  it('accepts direct restarts after spawning a replacement process', async () => {
    const unref = vi.fn();
    const child = new EventEmitter();
    child.unref = unref;
    const spawnImpl = vi.fn(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    const setTimeoutImpl = vi.fn();
    const exit = vi.fn();
    const app = createApp(createUpdateRouter({
      env: { PILOTDECK_RESTART_MODE: 'start-built' },
      projectRoot: '/opt/pilotdeck',
      resolveRestartCommandImpl: vi.fn(async () => ({
        command: 'bash',
        args: ['-c', 'sleep 2 && npm run start:built'],
      })),
      spawnImpl,
      setTimeoutImpl,
      exit,
      getInstanceInfo: () => instanceInfo,
      log: vi.fn(),
      error: vi.fn(),
    }));

    const response = await requestJson(app, '/api/update/restart', { method: 'POST' });

    expect(response).toEqual({
      status: 202,
      body: {
        status: 'accepted',
        restartMode: 'direct',
        previousInstanceId: 'old-instance',
        previousStartedAt: '2026-08-24T04:00:00.000Z',
        previousPid: 12345,
      },
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      'bash',
      ['-c', 'sleep 2 && npm run start:built'],
      expect.objectContaining({
        cwd: '/opt/pilotdeck',
        detached: true,
        stdio: 'ignore',
      }),
    );
    expect(unref).toHaveBeenCalledTimes(1);
    setTimeoutImpl.mock.calls[0][0]();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('returns 500 when direct replacement spawning fails', async () => {
    const setTimeoutImpl = vi.fn();
    const app = createApp(createUpdateRouter({
      env: { PILOTDECK_RESTART_MODE: 'start-built' },
      resolveRestartCommandImpl: vi.fn(async () => ({
        command: 'missing',
        args: [],
      })),
      spawnImpl: vi.fn(() => {
        throw new Error('spawn failed');
      }),
      setTimeoutImpl,
      log: vi.fn(),
      error: vi.fn(),
    }));

    const response = await requestJson(app, '/api/update/restart', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('spawn failed');
    expect(setTimeoutImpl).not.toHaveBeenCalled();
  });

  it('returns 500 when direct replacement spawning emits an async error', async () => {
    const unref = vi.fn();
    const child = new EventEmitter();
    child.unref = unref;
    const setTimeoutImpl = vi.fn();
    const app = createApp(createUpdateRouter({
      env: { PILOTDECK_RESTART_MODE: 'start-built' },
      resolveRestartCommandImpl: vi.fn(async () => ({
        command: 'missing',
        args: [],
      })),
      spawnImpl: vi.fn(() => {
        setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
        return child;
      }),
      setTimeoutImpl,
      log: vi.fn(),
      error: vi.fn(),
    }));

    const response = await requestJson(app, '/api/update/restart', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('spawn ENOENT');
    expect(unref).not.toHaveBeenCalled();
    expect(setTimeoutImpl).not.toHaveBeenCalled();
  });
});
