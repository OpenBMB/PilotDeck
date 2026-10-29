import express from 'express';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ platform: false, calls: new Map() }));
vi.mock('../constants/config.js', () => ({ get IS_PLATFORM() { return mocks.platform; } }));
vi.mock('../database/db.js', () => ({
  userDb: { getFirstUser: () => ({ id: 'platform-user' }) },
  apiKeysDb: { validateApiKey: key => ['key-alice', 'key-bob'].includes(key) ? { id: key.slice(4) } : null },
  githubTokensDb: {},
}));
vi.mock('../projects.js', () => ({ addProjectManually: async path => ({ path }) }));
vi.mock('../pilotdeck-bridge.js', () => ({ runChatViaGateway: async message => {
  await new Promise(resolve => setTimeout(resolve, message.includes('alice') ? 5 : 1));
  mocks.calls.set(message, requestContextHeaders({ purpose: 'conversation' }));
} }));
import agentRouter from './agent.js';
import { createRequestContextMiddleware } from '../middleware/requestContext.js';
import { anonymousRequestId, requestContextHeaders } from '../../../src/network/requestContext.js';
import { requestLimiters } from '../middleware/rateLimits.js';

const home = mkdtempSync(join(tmpdir(), 'pilotdeck-agent-context-'));
const saved = { home: process.env.PILOT_HOME, mode: process.env.PILOTDECK_REQUEST_HEADERS };
let server; let url;
beforeAll(async () => {
  process.env.PILOT_HOME = home;
  const app = express();
  app.use(requestLimiters.ingress);
  app.use(express.json());
  app.use(createRequestContextMiddleware());
  app.use('/api/agent', agentRouter);
  server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  url = `http://127.0.0.1:${server.address().port}/api/agent`;
});
beforeEach(() => { mocks.platform = false; mocks.calls.clear(); process.env.PILOTDECK_REQUEST_HEADERS = 'full'; });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (saved.home === undefined) delete process.env.PILOT_HOME; else process.env.PILOT_HOME = saved.home;
  if (saved.mode === undefined) delete process.env.PILOTDECK_REQUEST_HEADERS; else process.env.PILOTDECK_REQUEST_HEADERS = saved.mode;
  rmSync(home, { recursive: true, force: true });
});
const send = (message, headers = {}, query = '') => fetch(url + query, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ projectPath: home, message, stream: false, cleanup: false, requestContext: { userId: 'spoofed' } }) });

it('attributes concurrent API key users independently and preserves the response correlation ID', async () => {
  const users = ['alice', 'bob'];
  const ids = await Promise.all(users.map(async user => {
    const requestId = randomUUID(); const deviceId = randomUUID();
    const response = await send(user, { 'x-api-key': `key-${user}`, 'x-pilotdeck-user-id': 'f'.repeat(32),
      'x-pilotdeck-request-id': requestId, 'x-pilotdeck-device-id': deviceId, 'x-pilotdeck-version': '2026.10.29' });
    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    const headers = mocks.calls.get(user);
    expect(headers['x-pilotdeck-user-id']).toBe(anonymousRequestId('user', user));
    expect(headers['x-pilotdeck-user-id']).toBe(response.headers.get('x-pilotdeck-user-id'));
    expect(headers['x-pilotdeck-parent-request-id']).toBe(requestId);
    expect(headers['x-pilotdeck-parent-request-id']).toBe(response.headers.get('x-pilotdeck-request-id'));
    expect(headers['x-pilotdeck-device-id']).toBe(deviceId);
    expect(headers['x-pilotdeck-client-version']).toBe('2026.10.29');
    return headers['x-pilotdeck-user-id'];
  }));
  expect(ids[0]).not.toBe(ids[1]);
});
it('initializes query-key and platform authentication contexts', async () => {
  expect((await send('query', {}, '?apiKey=key-alice')).status).toBe(200);
  expect(mocks.calls.get('query')['x-pilotdeck-user-id']).toBe(anonymousRequestId('user', 'alice'));
  mocks.platform = true;
  expect((await send('platform')).status).toBe(200);
  expect(mocks.calls.get('platform')['x-pilotdeck-user-id']).toBe(anonymousRequestId('user', 'platform-user'));
});
it.each([undefined, 'inactive-key'])('rejects missing/inactive API keys before model dispatch (%s)', async key => {
  expect((await send('rejected', key ? { 'x-api-key': key } : {})).status).toBe(401);
  expect(mocks.calls.size).toBe(0);
});
it.each(['basic', 'off'])('preserves %s privacy mode for API key authentication', async mode => {
  process.env.PILOTDECK_REQUEST_HEADERS = mode;
  const response = await send(mode, { 'x-api-key': 'key-alice' });
  expect(response.status).toBe(200);
  expect(response.headers.has('x-pilotdeck-user-id')).toBe(false);
  expect(mocks.calls.get(mode)['x-pilotdeck-user-id']).toBeUndefined();
});

it('limits external model tasks before project/model work while keeping another account available', async () => {
  requestLimiters.model.resetKey('user:alice');
  requestLimiters.model.resetKey('user:bob');
  for (let i = 0; i < 30; i++) expect((await send(`model-${i}`, { 'x-api-key': 'key-alice' })).status).toBe(200);
  const blocked = await send('blocked-model', { 'x-api-key': 'key-alice' });
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(mocks.calls.has('blocked-model')).toBe(false);
  expect((await send('other-model', { 'x-api-key': 'key-bob' })).status).toBe(200);
});
