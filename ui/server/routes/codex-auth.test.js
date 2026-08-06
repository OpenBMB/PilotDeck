import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAuthRouter } from './codex-auth.js';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Codex auth routes', () => {
  it('keeps device secrets server-side and completes the OAuth exchange by opaque state', async () => {
    let now = 1_000;
    const pollCodexDeviceCode = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({
        status: 'authorized',
        authorizationCode: 'authorization-code',
        codeVerifier: 'code-verifier',
      });
    const exchangeCodexDeviceAuthorization = vi.fn(async () => undefined);
    const router = createCodexAuthRouter({
      requestCodexDeviceCode: vi.fn(async () => ({
        userCode: 'ABCD-EFGH',
        deviceAuthId: 'server-only-device-secret',
        verificationUrl: 'https://auth.openai.com/codex/device',
        intervalMs: 3_000,
      })),
      pollCodexDeviceCode,
      exchangeCodexDeviceAuthorization,
      getCodexAuthStatus: vi.fn(async () => ({
        authenticated: true,
        importAvailable: false,
        accountId: 'acct_test',
      })),
      uuid: () => 'opaque-state',
      now: () => now,
    });
    const request = createRequest(router);

    const started = await request('/device/start', { method: 'POST' });
    expect(started).toMatchObject({
      ok: true,
      state: 'opaque-state',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
    expect(JSON.stringify(started)).not.toContain('server-only-device-secret');

    now += started.intervalMs;
    expect(await request('/device/poll', {
      method: 'POST',
      body: JSON.stringify({ state: started.state }),
    })).toEqual({ ok: true, pending: true });
    now += started.intervalMs;
    const completed = await request('/device/poll', {
      method: 'POST',
      body: JSON.stringify({ state: started.state }),
    });

    expect(completed).toMatchObject({
      ok: true,
      pending: false,
      authenticated: true,
      accountId: 'acct_test',
    });
    expect(pollCodexDeviceCode).toHaveBeenCalledWith(expect.objectContaining({
      userCode: 'ABCD-EFGH',
      deviceAuthId: 'server-only-device-secret',
    }));
    expect(exchangeCodexDeviceAuthorization).toHaveBeenCalledWith({
      status: 'authorized',
      authorizationCode: 'authorization-code',
      codeVerifier: 'code-verifier',
    });
  });

  it('enforces the device interval without consuming opaque state', async () => {
    let now = 10_000;
    const pollCodexDeviceCode = vi.fn(async () => ({ status: 'pending' }));
    const router = createCodexAuthRouter({
      requestCodexDeviceCode: vi.fn(async () => ({
        userCode: 'ABCD-EFGH',
        deviceAuthId: 'device-secret',
        verificationUrl: 'https://auth.openai.com/codex/device',
        intervalMs: 3_000,
      })),
      pollCodexDeviceCode,
      uuid: () => 'opaque-state',
      now: () => now,
    });
    const request = createRequest(router);
    const started = await request('/device/start', { method: 'POST' });

    const early = await request('/device/poll', {
      method: 'POST',
      body: JSON.stringify({ state: started.state }),
      response: true,
    });
    expect(early).toEqual({
      status: 429,
      body: {
        ok: false,
        pending: true,
        retryAfterMs: 3_000,
        error: 'Device login was polled too soon.',
      },
    });
    expect(pollCodexDeviceCode).not.toHaveBeenCalled();

    now += 3_000;
    expect(await request('/device/poll', {
      method: 'POST',
      body: JSON.stringify({ state: started.state }),
    })).toEqual({ ok: true, pending: true });
    expect(pollCodexDeviceCode).toHaveBeenCalledOnce();

    const repeated = await request('/device/poll', {
      method: 'POST',
      body: JSON.stringify({ state: started.state }),
      response: true,
    });
    expect(repeated.status).toBe(429);
    expect(repeated.body.retryAfterMs).toBe(3_000);
    expect(pollCodexDeviceCode).toHaveBeenCalledOnce();
  });

  it('rejects a concurrent poll while its authorization exchange is in progress', async () => {
    let now = 20_000;
    const exchange = deferred();
    const pollCodexDeviceCode = vi.fn(async () => ({
      status: 'authorized',
      authorizationCode: 'authorization-code',
      codeVerifier: 'code-verifier',
    }));
    const exchangeCodexDeviceAuthorization = vi.fn(() => exchange.promise);
    const router = createCodexAuthRouter({
      requestCodexDeviceCode: vi.fn(async () => ({
        userCode: 'ABCD-EFGH',
        deviceAuthId: 'device-secret',
        verificationUrl: 'https://auth.openai.com/codex/device',
        intervalMs: 3_000,
      })),
      pollCodexDeviceCode,
      exchangeCodexDeviceAuthorization,
      getCodexAuthStatus: vi.fn(async () => ({ authenticated: true })),
      uuid: () => 'opaque-state',
      now: () => now,
    });
    const request = createRequest(router);
    const started = await request('/device/start', { method: 'POST' });
    now += 3_000;

    const first = request('/device/poll', {
      method: 'POST',
      body: JSON.stringify({ state: started.state }),
    });
    await vi.waitFor(() => expect(exchangeCodexDeviceAuthorization).toHaveBeenCalledOnce());
    const concurrent = await request('/device/poll', {
      method: 'POST',
      body: JSON.stringify({ state: started.state }),
      response: true,
    });

    expect(concurrent).toEqual({
      status: 409,
      body: {
        ok: false,
        pending: true,
        error: 'A device login poll is already in progress.',
      },
    });
    expect(pollCodexDeviceCode).toHaveBeenCalledOnce();
    expect(exchangeCodexDeviceAuthorization).toHaveBeenCalledOnce();

    exchange.resolve();
    await expect(first).resolves.toMatchObject({ ok: true, pending: false, authenticated: true });
  });

  it('imports existing Codex credentials and clears only PilotDeck credentials', async () => {
    const importCodexCliCredentials = vi.fn(async () => ({
      accessToken: 'secret',
      source: 'codex-cli-import',
    }));
    const clearCodexCredentials = vi.fn(async () => undefined);
    const router = createCodexAuthRouter({
      importCodexCliCredentials,
      clearCodexCredentials,
      getCodexAuthStatus: vi.fn(async () => ({
        authenticated: true,
        importAvailable: true,
      })),
    });
    const request = createRequest(router);

    const imported = await request('/import', { method: 'POST' });
    expect(imported).toEqual({
      ok: true,
      authenticated: true,
      importAvailable: true,
    });
    expect(JSON.stringify(imported)).not.toContain('secret');

    expect(await request('/', { method: 'DELETE' })).toEqual({
      ok: true,
      authenticated: false,
    });
    expect(importCodexCliCredentials).toHaveBeenCalledOnce();
    expect(clearCodexCredentials).toHaveBeenCalledOnce();
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createRequest(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/codex-auth', router);
  return async (path, init = {}) => {
    const server = app.listen(0);
    try {
      const { response: includeResponse, ...fetchInit } = init;
      const { port } = server.address();
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/codex-auth${path}`, {
        headers: { 'Content-Type': 'application/json', ...(fetchInit.headers || {}) },
        ...fetchInit,
      });
      const body = await response.json();
      return includeResponse ? { status: response.status, body } : body;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
