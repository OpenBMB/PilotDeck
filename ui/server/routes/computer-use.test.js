// @vitest-environment node
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComputerUseRouter } from './computer-use.js';
let server, base, service, env;
beforeEach(async () => {
  service = { status: vi.fn(async () => ({ enabled: false, phase: 'disabled', platform: 'darwin' })),
    setEnabled: vi.fn(async enabled => ({ enabled })), refresh: vi.fn(async () => ({ phase: 'ready' })), requestPermission: vi.fn(async () => ({ phase: 'needs-permissions' })),
    revealPermissionApp: vi.fn(async () => ({ phase: 'needs-permissions' })) };
  env = { HOST: '127.0.0.1' };
  const app = express(); app.use(express.json()); app.use(createComputerUseRouter({ service, env }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { code: response.status, body: await response.json() };
}
describe('computer use HTTP API', () => {
  it('reads status without enabling or requesting permissions', async () => {
    expect((await request('/status')).body.phase).toBe('disabled');
    expect(service.setEnabled).not.toHaveBeenCalled(); expect(service.requestPermission).not.toHaveBeenCalled();
  });
  it('delegates explicit actions to the backend', async () => {
    expect((await request('/enabled', 'PUT', { enabled: true }, { Origin: base })).body.enabled).toBe(true);
    await request('/permissions', 'POST', { permission: 'screenRecording' });
    expect(service.requestPermission).toHaveBeenCalledWith('screenRecording');
    expect((await request('/refresh', 'POST')).body.phase).toBe('ready');
  });
  it('rejects invalid inputs before invoking native actions', async () => {
    expect((await request('/enabled', 'PUT', { enabled: 'true' })).code).toBe(400);
    expect((await request('/permissions', 'POST', { permission: 'shell' })).code).toBe(400);
    expect(service.setEnabled).not.toHaveBeenCalled(); expect(service.requestPermission).not.toHaveBeenCalled();
  });
  it('reveals only the host-selected permission application, ignoring browser-supplied paths', async () => {
    expect((await request('/permission-app/reveal', 'POST', { path: '/untrusted/app' })).code).toBe(200);
    expect(service.revealPermissionApp).toHaveBeenCalledExactlyOnceWith();
    expect(service.requestPermission).not.toHaveBeenCalled(); expect(service.setEnabled).not.toHaveBeenCalled();
  });
  it.each([{ Origin: 'https://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'rebind.example:3001', Origin: 'http://rebind.example:3001' }])('blocks foreign origins and DNS rebinding: %j', async headers => {
    expect((await request('/enabled', 'PUT', { enabled: true }, headers)).code).toBe(403);
    expect(service.setEnabled).not.toHaveBeenCalled();
    expect((await request('/permission-app/reveal', 'POST', undefined, headers)).code).toBe(403);
    expect(service.revealPermissionApp).not.toHaveBeenCalled();
  });
  it('blocks DNS rebinding even when a local instance binds all interfaces', async () => {
    env.HOST = '0.0.0.0';
    expect((await request('/enabled', 'PUT', { enabled: true }, { Host: 'rebind.example:3001', Origin: 'http://rebind.example:3001' })).code).toBe(403);
    expect(service.setEnabled).not.toHaveBeenCalled();
  });
  it('permits the local development frontend', async () => {
    expect((await request('/status', 'GET', undefined, { Origin: 'http://localhost:5173' })).code).toBe(200);
  });
  it('reports backend failures without claiming the action succeeded', async () => {
    service.setEnabled.mockRejectedValueOnce(new Error('host disconnected'));
    expect(await request('/enabled', 'PUT', { enabled: true })).toEqual({ code: 503, body: { error: 'host disconnected' } });
  });
});
