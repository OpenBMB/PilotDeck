// @vitest-environment node
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import { createRequestLimiters, clientRateKey, userRateKey } from './rateLimits.js';
import { configureTrustedProxy } from '../utils/trustedProxy.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }));
});
async function serve(install) {
  const app = express(); install(app);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return (path = '/api/test', init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
}
const env = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [`PILOTDECK_${key}`, String(value)]));

it('rejects excess ingress before JSON parsing/auth; ignores forged forwarding headers and keeps health/static available', async () => {
  const limits = createRequestLimiters({ env: env({ API_IP_LIMIT: 2 }) });
  let auth = 0;
  const request = await serve(app => {
    app.use('/api', limits.ingress);
    app.use(express.json());
    app.use('/api', (_req, _res, next) => { auth++; next(); });
    app.post('/api/test', (_req, res) => res.json({ ok: true }));
    app.get('/health', (_req, res) => res.sendStatus(200));
    app.get('/assets/test.js', (_req, res) => res.sendStatus(200));
  });
  for (let i = 0; i < 2; i++) expect((await request(undefined, { method: 'POST' })).status).toBe(200);
  const blocked = await request(undefined, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', 'x-pilotdeck-device-id': 'changed' }, body: '{invalid' });
  expect(blocked.status).toBe(429);
  expect((await blocked.json()).code).toBe('RATE_LIMITED');
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(blocked.headers.get('ratelimit')).toContain('api-ingress');
  expect(auth).toBe(2);
  expect((await request('/health')).status).toBe(200);
  expect((await request('/assets/test.js')).status).toBe(200);
});

it('counts repeated authenticated middleware once, separates users behind one IP and recovers after the window', async () => {
  const limits = createRequestLimiters({ env: env({ API_USER_LIMIT: 1 }), windowMs: 120 });
  const request = await serve(app => {
    app.use(limits.ingress);
    // Synthetic authenticated principals, not production client headers.
    app.use((req, _res, next) => { req.user = { id: req.query.user }; next(); });
    app.use(limits.user);
    app.get('/api/test', limits.user, (_req, res) => res.sendStatus(200));
  });
  expect((await request('/api/test?user=a')).status).toBe(200);
  expect((await request('/api/test?user=a')).status).toBe(429);
  expect((await request('/api/test?user=b')).status).toBe(200);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect((await request('/api/test?user=a')).status).toBe(200);
});

it('blocks concurrent expensive dispatches without interrupting an admitted stream or ordinary API calls', async () => {
  const limits = createRequestLimiters({ env: env({ HTTP_MODEL_LIMIT: 1 }) });
  let release; const gate = new Promise(resolve => { release = resolve; });
  let dispatches = 0;
  const request = await serve(app => {
    app.use(limits.ingress);
    app.use((req, _res, next) => { req.user = { id: 'authenticated-user' }; next(); });
    app.get('/api/model', limits.model, async (_req, res) => {
      dispatches++; res.setHeader('content-type', 'text/event-stream'); res.flushHeaders();
      res.write('data: first\n\n'); await gate; res.end('data: last\n\n');
    });
    app.get('/api/test', limits.user, (_req, res) => res.sendStatus(200));
  });
  try {
    const stream = await request('/api/model');
    expect(stream.status).toBe(200);
    const blocked = await Promise.all(Array.from({ length: 8 }, () => request('/api/model')));
    expect(blocked.every(response => response.status === 429)).toBe(true);
    expect(dispatches).toBe(1);
    expect((await request()).status).toBe(200);
    release(); expect(await stream.text()).toBe('data: first\n\ndata: last\n\n');
  } finally { release(); }
});

it('refunds successful sign-ins but limits failed attempts before password work', async () => {
  const limits = createRequestLimiters({ env: env({ AUTH_ATTEMPT_LIMIT: 2 }) });
  let checked = 0;
  const request = await serve(app => {
    app.use(limits.ingress);
    app.post('/api/login', limits.auth, (req, res) => { checked++; res.sendStatus(req.query.valid === 'yes' ? 200 : 401); });
  });
  for (let i = 0; i < 5; i++) expect((await request('/api/login?valid=yes', { method: 'POST' })).status).toBe(200);
  for (let i = 0; i < 2; i++) expect((await request('/api/login', { method: 'POST' })).status).toBe(401);
  expect((await request('/api/login', { method: 'POST' })).status).toBe(429);
  expect(checked).toBe(7);
});

it('allows a full 500-image batch and multi-tab polling at defaults', async () => {
  const limits = createRequestLimiters({ env: {} });
  const request = await serve(app => {
    app.use(limits.ingress);
    app.use((req, _res, next) => { req.user = { id: 'local' }; next(); });
    app.use(limits.user);
    app.get('/api/test', (_req, res) => res.sendStatus(200));
  });
  for (let batch = 0; batch < 30; batch++) {
    const responses = await Promise.all(Array.from({ length: 20 }, () => request()));
    expect(responses.every(response => response.status === 200)).toBe(true);
  }
});

it('groups IPv6 address rotation and only accepts server-assigned user identity', () => {
  expect(clientRateKey({ ip: '2001:db8:abcd:1200::1' })).toBe(clientRateKey({ ip: '2001:db8:abcd:1200::ffff' }));
  expect(userRateKey({ ip: '127.0.0.1', headers: { 'x-pilotdeck-user-id': 'spoofed' } })).toBe('ip:127.0.0.1');
  expect(userRateKey({ ip: '127.0.0.1', user: { id: 0 } })).toBe('user:0');
});

it.each([false, true])('respects the existing explicit proxy trust boundary (trusted=%s)', async trusted => {
  const limits = createRequestLimiters({ env: env({ API_IP_LIMIT: 1 }) });
  const request = await serve(app => {
    configureTrustedProxy(app, { PILOTDECK_TRUST_PROXY: trusted ? 'loopback' : '203.0.113.0/24' });
    app.use(limits.ingress);
    app.get('/api/test', (_req, res) => res.sendStatus(200));
  });
  expect((await request(undefined, { headers: { 'x-forwarded-for': '198.51.100.1' } })).status).toBe(200);
  expect((await request(undefined, { headers: { 'x-forwarded-for': '198.51.100.2' } })).status).toBe(trusted ? 200 : 429);
});

it('invalid or zero configuration retains protection instead of disabling it', async () => {
  const limits = createRequestLimiters({ env: env({ AUTH_ATTEMPT_LIMIT: 0 }) });
  const request = await serve(app => {
    app.use(limits.ingress);
    app.post('/api/test', limits.auth, (_req, res) => res.sendStatus(401));
  });
  for (let i = 0; i < 20; i++) expect((await request(undefined, { method: 'POST' })).status).toBe(401);
  expect((await request(undefined, { method: 'POST' })).status).toBe(429);
});
