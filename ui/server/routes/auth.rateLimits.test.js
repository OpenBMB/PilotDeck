// @vitest-environment node
import express from 'express';
import { afterAll, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ compare: vi.fn(async () => false), lookup: vi.fn(() => ({ id: 1, password_hash: 'fixture' })) }));
vi.mock('bcrypt', () => ({ default: { compare: mocks.compare } }));
vi.mock('../database/db.js', () => ({ userDb: { getUserByUsername: mocks.lookup, hasUsers: () => true }, db: {} }));
vi.mock('../middleware/auth.js', () => ({ generateToken: () => 'fixture-token', authenticateToken: (_req, _res, next) => next() }));
vi.mock('../constants/config.js', () => ({ DISABLE_LOCAL_AUTH: false }));
import authRoutes from './auth.js';
import { requestLimiters } from '../middleware/rateLimits.js';
const servers = [];
afterAll(async () => { await Promise.all(servers.map(server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); })); });

it('enforces login/registration limits before bcrypt while status checks remain available', async () => {
  requestLimiters.auth.resetKey('127.0.0.1');
  const app = express();
  app.use('/api', requestLimiters.ingress);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}/api/auth`;
  const login = () => fetch(`${url}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'fixture', password: 'wrong' }) });
  for (let i = 0; i < 20; i++) expect((await login()).status).toBe(401);
  const blocked = await login();
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(mocks.compare).toHaveBeenCalledTimes(20);
  expect(mocks.lookup).toHaveBeenCalledTimes(20);
  expect((await fetch(`${url}/register`, { method: 'POST' })).status).toBe(429);
  expect((await fetch(`${url}/status`)).status).toBe(200);
});
