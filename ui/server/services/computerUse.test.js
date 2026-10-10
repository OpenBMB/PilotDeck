// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createComputerUseService } from './computerUse.js';

function setup(timeoutMs = 1000) {
  const host = new EventEmitter(); host.connected = true; host.send = vi.fn();
  const standaloneFactory = vi.fn();
  const service = createComputerUseService({ env: { PILOTDECK_DESKTOP: '1' }, processLike: host, standaloneFactory, timeoutMs });
  return { host, service, standaloneFactory };
}
const reply = (host, index, result) => host.emit('message', { type: 'pilotdeck:computer-use-response', id: host.send.mock.calls[index][0].id, ...result });
describe('shared computer use service', () => {
  it('uses a standalone backend outside Electron', () => {
    const backend = {}; const factory = vi.fn(() => backend);
    expect(createComputerUseService({ env: {}, standaloneFactory: factory })).toBe(backend);
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
