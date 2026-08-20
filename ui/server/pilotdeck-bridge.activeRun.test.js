import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createRemoteGatewayMock, installGlobalProxyMock } = vi.hoisted(() => ({
  createRemoteGatewayMock: vi.fn(),
  installGlobalProxyMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/gateway/index.js', () => ({
  createRemoteGateway: createRemoteGatewayMock,
}));

vi.mock('../../src/cli/proxy.js', () => ({
  installGlobalProxy: installGlobalProxyMock,
}));

describe('pilotdeck bridge active run ownership', () => {
  let testRoot;
  let gateway;
  let bridge;

  beforeEach(async () => {
    vi.resetModules();
    createRemoteGatewayMock.mockReset();
    installGlobalProxyMock.mockClear();
    testRoot = await mkdtemp(path.join(tmpdir(), 'pilotdeck-bridge-active-run-'));
    const tokenPath = path.join(testRoot, 'server-token');
    await writeFile(tokenPath, 'test-token\n');
    process.env.PILOTDECK_GATEWAY_TOKEN_PATH = tokenPath;
    process.env.PILOTDECK_BRIDGE_TIMEOUT = '1000';
    gateway = {
      submitTurn: vi.fn(),
      abortTurn: vi.fn(async () => undefined),
      recordAgentStatusMessage: vi.fn(async () => undefined),
    };
    createRemoteGatewayMock.mockResolvedValue(gateway);
    bridge = await import('./pilotdeck-bridge.js');
  });

  afterEach(async () => {
    delete process.env.PILOTDECK_GATEWAY_TOKEN_PATH;
    delete process.env.PILOTDECK_BRIDGE_TIMEOUT;
    await rm(testRoot, { recursive: true, force: true });
  });

  it('clears the matching active run after a successful manual abort', async () => {
    const stream = controlledTurnStream();
    gateway.submitTurn.mockReturnValueOnce(stream.iterable);
    const running = bridge.runChatViaGateway(
      'first turn',
      { sessionId: 'web:s_active', projectPath: '/workspace/project' },
      writer(),
    );
    await stream.started.promise;
    expect(bridge.isSessionActiveViaGateway('web:s_active')).toBe(true);

    await expect(bridge.abortViaGateway('web:s_active')).resolves.toBe(true);

    expect(gateway.abortTurn).toHaveBeenCalledWith({
      sessionKey: 'web:s_active',
      runId: expect.any(String),
    });
    expect(bridge.isSessionActiveViaGateway('web:s_active')).toBe(false);
    stream.finish();
    await running;
  });

  it('does not let an older turn completion clear a newer active run', async () => {
    const first = controlledTurnStream();
    const second = controlledTurnStream();
    gateway.submitTurn
      .mockReturnValueOnce(first.iterable)
      .mockReturnValueOnce(second.iterable);

    const firstRun = bridge.runChatViaGateway(
      'first turn',
      { sessionId: 'web:s_overlap', projectPath: '/workspace/project' },
      writer(),
    );
    await first.started.promise;
    const secondRun = bridge.runChatViaGateway(
      'second turn',
      { sessionId: 'web:s_overlap', projectPath: '/workspace/project' },
      writer(),
    );
    await second.started.promise;

    first.finish();
    await firstRun;
    expect(bridge.isSessionActiveViaGateway('web:s_overlap')).toBe(true);

    second.finish();
    await secondRun;
    expect(bridge.isSessionActiveViaGateway('web:s_overlap')).toBe(false);
  });

  it('keeps the original run active when force-start abort fails', async () => {
    const original = controlledTurnStream();
    gateway.submitTurn.mockReturnValueOnce(original.iterable);
    gateway.abortTurn.mockRejectedValueOnce(new Error('gateway refused abort'));
    const firstWriter = writer();
    const originalRun = bridge.runChatViaGateway(
      'original turn',
      { sessionId: 'web:s_force', projectPath: '/workspace/project' },
      firstWriter,
    );
    await original.started.promise;

    const queuedWriter = writer();
    await bridge.runChatViaGateway(
      'queued turn',
      {
        sessionId: 'web:s_force',
        projectPath: '/workspace/project',
        forceStart: true,
      },
      queuedWriter,
    );

    expect(gateway.submitTurn).toHaveBeenCalledTimes(1);
    expect(queuedWriter.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'error',
      code: 'force_start_abort_failed',
    }));
    expect(bridge.isSessionActiveViaGateway('web:s_force')).toBe(true);

    original.finish();
    await originalRun;
    expect(bridge.isSessionActiveViaGateway('web:s_force')).toBe(false);
  });
});

function writer() {
  return { send: vi.fn() };
}

function controlledTurnStream() {
  const started = deferred();
  const finished = deferred();
  return {
    started,
    finish: () => finished.resolve(),
    iterable: (async function* () {
      started.resolve();
      await finished.promise;
      yield {
        type: 'turn_completed',
        result: {
          type: 'success',
          stopReason: 'completed',
          usage: {},
          permissionDenials: [],
          turns: 1,
        },
      };
    })(),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
