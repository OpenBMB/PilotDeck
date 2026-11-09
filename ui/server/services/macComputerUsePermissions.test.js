// @vitest-environment node
import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { probeMacPermissions } from './macComputerUsePermissions.js';
const runtime = { app: '/fixture/PilotDeck Computer Use.app', bundleId: 'cn.pilotdeck.computer-use', probeSupported: true };
afterEach(() => vi.useRealTimers());

it('waits for native results without the process-exit watcher that races a short-lived helper', async () => {
  vi.useFakeTimers();
  let resultFile;
  const execute = vi.fn(async (_command, args) => {
    resultFile = args[args.indexOf('--result-file') + 1];
    const value = { host_bundle_id: runtime.bundleId, accessibility: false, screen_recording: true };
    if (args.includes('-W')) {
      fs.writeFileSync(resultFile, JSON.stringify(value));
      throw Object.assign(new Error('Unable to block on applications (initial call to kevent() failed: No such process)'), { code: 1 });
    }
    setTimeout(() => fs.writeFileSync(resultFile, JSON.stringify(value)), 25);
  });
  const probe = probeMacPermissions({ runtime, execute, env: {} }).then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(50);
  expect(await probe).toEqual({ value: { accessibility: false, screenRecording: true } });
  expect(execute).toHaveBeenCalledOnce();
  expect(fs.existsSync(resultFile)).toBe(false);
});

it('times out and cleans up when a successful launch never publishes a permission result', async () => {
  vi.useFakeTimers();
  let resultFile;
  const execute = vi.fn(async (_command, args) => { resultFile = args[args.indexOf('--result-file') + 1]; });
  const probe = probeMacPermissions({ runtime, execute, env: {} }).catch(error => error);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await probe).toBeInstanceOf(Error);
  expect((await probe).message).toMatch(/timed out/);
  expect(execute).toHaveBeenCalledOnce();
  expect(fs.existsSync(resultFile)).toBe(false);
});

it('preserves real launch failures and removes the unfilled result file', async () => {
  let resultFile;
  const denied = Object.assign(new Error('Launch denied'), { code: 'EPERM' });
  const execute = async (_command, args) => {
    resultFile = args[args.indexOf('--result-file') + 1];
    throw denied;
  };
  await expect(probeMacPermissions({ runtime, execute, env: {} })).rejects.toBe(denied);
  expect(fs.existsSync(resultFile)).toBe(false);
});

it('rejects malformed native output instead of reporting a permission grant', async () => {
  let resultFile;
  const execute = async (_command, args) => {
    resultFile = args[args.indexOf('--result-file') + 1];
    fs.writeFileSync(resultFile, '{"accessibility":');
  };
  await expect(probeMacPermissions({ runtime, execute, env: {} })).rejects.toBeInstanceOf(SyntaxError);
  expect(fs.existsSync(resultFile)).toBe(false);
});
it('queries a fresh native process without permission requests, screenshot probes or a Driver', async () => {
  let resultFile;
  const execute = vi.fn(async (command, args) => {
    expect(command).toBe('/usr/bin/open'); expect(args).toContain('probe'); expect(args).not.toContain('permissions');
    resultFile = args[args.indexOf('--result-file') + 1];
    fs.writeFileSync(resultFile, JSON.stringify({ host_bundle_id: runtime.bundleId, accessibility: false, screen_recording: true }));
  });
  expect(await probeMacPermissions({ runtime, execute, env: {} })).toEqual({ accessibility: false, screenRecording: true });
  expect(execute).toHaveBeenCalledOnce(); expect(fs.existsSync(resultFile)).toBe(false);
});
it.each([{ host_bundle_id: 'cn.pilotdeck.desktop', accessibility: true, screen_recording: true },
  { host_bundle_id: runtime.bundleId, accessibility: 'true', screen_recording: true }])('rejects an invalid result instead of turning it into a grant: %j', async value => {
  const execute = async (_command, args) => fs.writeFileSync(args[args.indexOf('--result-file') + 1], JSON.stringify(value));
  await expect(probeMacPermissions({ runtime, execute, env: {} })).rejects.toThrow('valid result');
});
