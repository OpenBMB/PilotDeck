// @vitest-environment node
import express from 'express';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComputerUseRouter } from './computer-use.js';
import { configureTrustedProxy } from '../utils/trustedProxy.js';
let server, base, service, env, app;
beforeEach(async () => {
  service = { status: vi.fn(async () => ({ enabled: false, phase: 'disabled', platform: 'darwin' })),
    setEnabled: vi.fn(async enabled => ({ enabled })), refresh: vi.fn(async () => ({ phase: 'ready' })), requestPermission: vi.fn(async () => ({ phase: 'needs-permissions' })),
    revealPermissionApp: vi.fn(async () => ({ phase: 'needs-permissions' })) };
  env = { HOST: '127.0.0.1' };
  app = express(); configureTrustedProxy(app, env); app.use(express.json()); app.use(createComputerUseRouter({ service, env }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function request(path, method = 'GET', body, headers = {}) {
  // Native fetch ignores a caller-supplied Host header. Use real HTTP so
  // reverse-proxy and DNS-rebinding tests exercise the intended public host.
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('error', reject); res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
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
  it('accepts authenticated same-origin actions behind a loopback HTTPS proxy', async () => {
    env.PILOTDECK_DISABLE_LOCAL_AUTH = '0';
    const headers = { Host: 'pilotdeck.example', Origin: 'https://pilotdeck.example', 'X-Forwarded-Proto': 'https' };
    expect((await request('/enabled', 'PUT', { enabled: true }, headers)).code).toBe(200);
    expect((await request('/refresh', 'POST', undefined, headers)).code).toBe(200);
    expect((await request('/permissions', 'POST', { permission: 'screenRecording' }, headers)).code).toBe(200);
    expect(service.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(service.refresh).toHaveBeenCalledExactlyOnceWith();
    expect(service.requestPermission).toHaveBeenCalledExactlyOnceWith('screenRecording');
  });
  it('accepts a proxy in the configured trusted CIDR', async () => {
    env.PILOTDECK_DISABLE_LOCAL_AUTH = 'false';
    env.PILOTDECK_TRUST_PROXY = '127.0.0.1/32'; configureTrustedProxy(app, env);
    expect((await request('/enabled', 'PUT', { enabled: true }, {
      Host: 'pilotdeck.example:8443', Origin: 'https://pilotdeck.example:8443', 'X-Forwarded-Proto': 'https',
    })).code).toBe(200);
  });
  it.each(['0', '127.0.0.2/32'])('ignores forwarded scheme from an untrusted peer (%s)', async trust => {
    env.PILOTDECK_DISABLE_LOCAL_AUTH = '0';
    env.PILOTDECK_TRUST_PROXY = trust; configureTrustedProxy(app, env);
    expect((await request('/enabled', 'PUT', { enabled: true }, {
      Host: 'pilotdeck.example', Origin: 'https://pilotdeck.example',
      'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.0.1',
    })).code).toBe(403);
    expect(service.setEnabled).not.toHaveBeenCalled();
  });
  it('still rejects foreign origins and forwarded host spoofing behind a trusted proxy', async () => {
    env.PILOTDECK_DISABLE_LOCAL_AUTH = '0';
    expect((await request('/enabled', 'PUT', { enabled: true }, {
      Host: 'pilotdeck.example', Origin: 'https://untrusted.example',
      'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'untrusted.example',
    })).code).toBe(403);
    expect(service.setEnabled).not.toHaveBeenCalled();
  });
  it('keeps unauthenticated local instances restricted to local hosts behind a proxy', async () => {
    expect((await request('/enabled', 'PUT', { enabled: true }, {
      Host: 'pilotdeck.example', Origin: 'https://pilotdeck.example', 'X-Forwarded-Proto': 'https',
    })).code).toBe(403);
    expect(service.setEnabled).not.toHaveBeenCalled();
  });
  it('reports backend failures without claiming the action succeeded', async () => {
    service.setEnabled.mockRejectedValueOnce(new Error('host disconnected'));
    expect(await request('/enabled', 'PUT', { enabled: true })).toEqual({ code: 503, body: { error: 'host disconnected' } });
  });
});
