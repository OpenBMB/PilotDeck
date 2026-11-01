// @vitest-environment node
import fs from 'node:fs';
import { expect, it, vi } from 'vitest';
import { probeMacPermissions } from './macComputerUsePermissions.js';
const runtime = { app: '/fixture/PilotDeck Computer Use.app', bundleId: 'cn.pilotdeck.computer-use', probeSupported: true };
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
