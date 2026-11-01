// @vitest-environment node
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createComputerUseService } from './computerUse.js';

function setup(timeoutMs = 1000, platform = 'win32') {
  const host = new EventEmitter(); host.connected = true; host.send = vi.fn();
  const standaloneFactory = vi.fn();
  const service = createComputerUseService({ env: { PILOTDECK_DESKTOP: '1' }, platform, processLike: host, standaloneFactory, timeoutMs });
  return { host, service, standaloneFactory };
}
const reply = (host, index, result) => host.emit('message', { type: 'pilotdeck:computer-use-response', id: host.send.mock.calls[index][0].id, ...result });
describe('shared computer use service', () => {
  it('uses a standalone backend outside Electron', () => {
    const backend = {}; const factory = vi.fn(() => backend);
    expect(createComputerUseService({ env: {}, standaloneFactory: factory })).toBe(backend);
  });
  it('uses the native helper in macOS desktop without reading Electron permissions or sending IPC', () => {
    const host = new EventEmitter(); host.connected = true; host.send = vi.fn();
    const backend = { status: vi.fn(async () => ({ permissionOwner: 'PilotDeck Computer Use' })) };
    const factory = vi.fn(() => backend);
    const service = createComputerUseService({ env: { PILOTDECK_DESKTOP: '1' }, platform: 'darwin', processLike: host, standaloneFactory: factory });
    expect(service).toBe(backend);
    expect(factory).toHaveBeenCalledOnce(); expect(host.send).not.toHaveBeenCalled();
    expect(host.listenerCount('message')).toBe(0);
  });
  it.each(['win32', 'linux'])('retains desktop host IPC on %s', async platform => {
    const { host, service, standaloneFactory } = setup(1000, platform);
    const request = service.status(); reply(host, 0, { status: { enabled: false } });
    expect(await request).toEqual({ enabled: false });
    expect(standaloneFactory).not.toHaveBeenCalled(); await service.stop();
  });
  it('keeps macOS desktop settings and MCP private while always selecting its bundled helper', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cu-desktop-service-'));
    const directory = path.join(home, 'Application Support/PilotDeck/computer-use');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ enabled: true }));
    const webDirectory = path.join(home, 'pilot-home/computer-use');
    fs.mkdirSync(webDirectory, { recursive: true });
    const webConfig = path.join(webDirectory, 'mcp.json');
    fs.writeFileSync(webConfig, 'web instance connection');
    const service = createComputerUseService({ platform: 'darwin', env: {
      PILOTDECK_DESKTOP: '1', PILOT_HOME: path.join(home, 'pilot-home'),
      PILOTDECK_COMPUTER_USE_DIRECTORY: directory,
      PILOTDECK_COMPUTER_USE_MCP_CONFIG: path.join(directory, 'mcp.json'),
      PILOTDECK_CUA_DRIVER_PATH: '/Applications/ExternalDriver.app/Contents/MacOS/cua-driver',
    } });
    try {
      expect(service.managed).toBe(true);
      expect(service.binary).not.toBe('/Applications/ExternalDriver.app/Contents/MacOS/cua-driver');
      expect(service.snapshot()).toMatchObject({ enabled: true, permissionOwner: 'PilotDeck Computer Use' });
      expect(service.directory).toBe(directory);
      expect(service.mcpConfigPath).toBe(path.join(directory, 'mcp.json'));
      expect(fs.readFileSync(webConfig, 'utf8')).toBe('web instance connection');
    } finally { await service.stop(); fs.rmSync(home, { recursive: true, force: true }); }
  });
  it('correlates concurrent desktop requests and never creates another native host', async () => {
    const { host, service, standaloneFactory } = setup();
    const status = service.status(); const enabled = service.setEnabled(true);
    expect(host.send.mock.calls[1][0]).toMatchObject({ action: 'setEnabled', value: true });
    reply(host, 1, { status: { enabled: true } }); reply(host, 0, { status: { enabled: false } });
    expect(await enabled).toEqual({ enabled: true }); expect(await status).toEqual({ enabled: false });
    expect(standaloneFactory).not.toHaveBeenCalled(); await service.stop();
    expect(host.listenerCount('message')).toBe(0);
  });
  it('surfaces native errors and disconnects instead of spawning a fallback Driver', async () => {
    const { host, service, standaloneFactory } = setup();
    const request = service.refresh(); reply(host, 0, { error: 'native failure' });
    await expect(request).rejects.toThrow('native failure');
    const pending = service.requestPermission('accessibility'); host.connected = false; host.emit('disconnect');
    await expect(pending).rejects.toThrow('disconnected'); await expect(service.status()).rejects.toThrow('unavailable');
    expect(standaloneFactory).not.toHaveBeenCalled(); await service.stop();
  });
  it('bounds an unresponsive native host', async () => {
    const { service } = setup(10);
    await expect(service.status()).rejects.toThrow('timed out'); await service.stop();
  });
  it('delegates permission-app reveal to the desktop GUI host without a caller-supplied path', async () => {
    const { host, service, standaloneFactory } = setup();
    const request = service.revealPermissionApp();
    expect(host.send.mock.calls[0][0]).toMatchObject({ action: 'revealPermissionApp' });
    expect(host.send.mock.calls[0][0].value).toBeUndefined();
    reply(host, 0, { status: { permissionAppPath: '/Applications/PilotDeck.app' } });
    expect(await request).toEqual({ permissionAppPath: '/Applications/PilotDeck.app' });
    expect(standaloneFactory).not.toHaveBeenCalled(); await service.stop();
  });
});
