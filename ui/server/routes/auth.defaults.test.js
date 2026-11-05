// @vitest-environment node
import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import viteConfig from '../../vite.config.js';

const mocks = vi.hoisted(() => ({
  user: { id: 1, username: 'local' },
  hasUsers: vi.fn(() => false),
}));
vi.mock('../load-env.js', () => ({}));
vi.mock('../database/db.js', () => ({
  db: {},
  userDb: { hasUsers: mocks.hasUsers, getFirstUser: () => mocks.user,
    getUserById: id => id === mocks.user.id ? mocks.user : undefined },
  appConfigDb: { getOrCreateJwtSecret: () => 'synthetic-test-secret' },
}));
vi.mock('../middleware/rateLimits.js', () => ({
  requestLimiters: { auth: (_req, _res, next) => next(), user: (_req, _res, next) => next() },
}));

let server;
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined; }
  vi.unstubAllEnvs();
});

const flagCases = [
  [undefined, true], ['', true], ['1', true], ['true', true],
  ['0', false], ['false', false], ['typo', false],
];
const authCases = [undefined, '0.0.0.0'].flatMap(host => flagCases.map(([value, disabled]) => [host, value, disabled]));
it.each(authCases)('keeps Web build, HTTP and WebSocket authentication consistent on host %s with flag %s', async (host, value, disabled) => {
  vi.stubEnv('HOST', host);
  vi.stubEnv('PILOTDECK_DISABLE_LOCAL_AUTH', value);
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  const { default: router } = await import('./auth.js');
  const { authenticateWebSocket, generateToken } = await import('../middleware/auth.js');
  const client = viteConfig({ mode: 'test', command: 'serve' });
  expect(JSON.parse(client.define['import.meta.env.VITE_DISABLE_LOCAL_AUTH'])).toBe(String(disabled));

  const app = express(); app.use(express.json()); app.use(router);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/status`)).json();
  expect(status).toEqual(disabled
    ? { needsSetup: false, isAuthenticated: true, authDisabled: true }
    : { needsSetup: true, isAuthenticated: false });
  const user = await fetch(`${base}/user`);
  expect(user.status).toBe(disabled ? 200 : 401);
  if (disabled) expect((await user.json()).user.username).toBe('local');
  expect(Boolean(authenticateWebSocket(null))).toBe(disabled);
  const token = generateToken(mocks.user);
  expect((await fetch(`${base}/user`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  expect(authenticateWebSocket(token).userId).toBe(mocks.user.id);

  for (const action of ['register', 'login']) {
    const response = await fetch(`${base}/${action}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' });
    // Disabled entry points reject requests; explicit account mode retains input validation.
    expect(response.status).toBe(disabled ? 403 : 400);
  }
});
