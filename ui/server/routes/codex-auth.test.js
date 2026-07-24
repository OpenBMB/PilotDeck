import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAuthRouter } from './codex-auth.js';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Codex auth routes', () => {
  it('keeps device secrets server-side and completes the OAuth exchange by opaque state', async () => {
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
      now: () => 1_000,
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

    expect(await request('/device/poll', {
      method: 'POST',
      body: JSON.stringify({ state: started.state }),
    })).toEqual({ ok: true, pending: true });
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

function createRequest(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/codex-auth', router);
  return async (path, init = {}) => {
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/codex-auth${path}`, {
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
        ...init,
      });
      return response.json();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
