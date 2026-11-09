// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import ts from 'typescript';
import { it, expect, vi } from 'vitest';
import { resolveConfigHome, redactDiagnostic } from '@pilotdeck/config';
import { waitForPortOrProcessExit } from '../../../apps/desktop/src/runtimeReadiness.ts';

// Exercise the actual runtime class without booting Electron or local services.
const main = readFileSync(new URL('../../../apps/desktop/src/main.ts', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('class RuntimeManager {'), main.indexOf('async function ensureRuntime()'));
function setup(killProcessTree) {
  const context = vm.createContext({ killProcessTree, path, AbortController, DOMException, resolveConfigHome, redactDiagnostic, os: { EOL: '\n' },
    app: { isPackaged: true, getPath: () => '/tmp', setAppLogsPath: vi.fn() }, publishRuntimeStatus: vi.fn() });
  vm.runInContext(ts.transpileModule(source + '\nglobalThis.RuntimeManager = RuntimeManager;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const manager = new context.RuntimeManager('/tmp', process.execPath);
  const child = { pid: 123, exitCode: 0 };
  manager.processes.push({ name: 'server', child });
  manager.serverProcess = child;
  manager.info = { ready: true };
  return { manager, child };
}

it('retains failed process records and runtime references, then retries shutdown', async () => {
  const stop = vi.fn().mockRejectedValueOnce(new Error('taskkill exit 1')).mockResolvedValueOnce();
  const { manager, child } = setup(stop);
  await expect(manager.stop()).rejects.toThrow('process records retained');
  expect(manager.processes).toHaveLength(1);
  expect(manager.serverProcess).toBe(child);
  expect(manager.getInfo()).toBeTruthy();
  await manager.stop();
  expect(stop).toHaveBeenCalledTimes(2);
  expect(manager.processes).toHaveLength(0);
  expect(manager.serverProcess).toBeNull();
  expect(manager.getInfo()).toBeNull();
});

it('does not discard an exited parent until the process tree check succeeds', async () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const { manager, child } = setup(stop);
  await manager.stop();
  expect(stop).toHaveBeenCalledWith(child);
});

it('rejects startup when the managed command exits while its guardian remains alive', async () => {
  const { EventEmitter } = await import('node:events');
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const connect = vi.spyOn(net, 'createConnection').mockReturnValue(socket);
  try {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    const readiness = waitForPortOrProcessExit(child, 'gateway', 18789, '127.0.0.1', 90000, '/tmp/test.log');
    child.emit('managed-exit', 2, null);
    await expect(readiness).rejects.toThrow('gateway exited before it was ready');
    expect(child.exitCode).toBeNull();
    expect(child.listenerCount('managed-exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(socket.destroy).toHaveBeenCalledOnce();
  } finally { connect.mockRestore(); }
});
