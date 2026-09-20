import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
});

async function request(app, path, options) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('SOP routes', () => {
  it('forwards status through the read retry helper', async () => {
    const status = { sessionId: 'session-1', revision: 2, state: { status: 'handoff' }, wait: { id: 'wait-1' } };
    const readRetry = vi.fn(async (operation) => operation({ sopStatus: vi.fn(async () => status) }));
    const { createSopRouter } = await import('./sop.js');
    const app = express();
    app.use('/api/sop', createSopRouter({ readRetry }));

    const response = await request(app, '/api/sop/status?sessionKey=session-1&projectKey=%2Fproject');

    expect(response).toEqual({ status: 200, body: { status } });
    expect(readRetry).toHaveBeenCalledOnce();
  });

  it('forwards a resume request without replaying it', async () => {
    const resumeSop = vi.fn(async (input) => ({ accepted: true, duplicate: false, ...input, revision: 3 }));
    const { createSopRouter } = await import('./sop.js');
    const app = express();
    app.use(express.json());
    app.use('/api/sop', createSopRouter({ getGateway: async () => ({ resumeSop }) }));

    const payload = {
      sessionKey: 'session-1', projectKey: '/project', requestId: 'resume-1', waitId: 'wait-1',
      source: 'human', message: 'Approved.', expectedRevision: 2, slotUpdates: { approved: true },
    };
    const response = await request(app, '/api/sop/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: true, duplicate: false, requestId: 'resume-1', revision: 3 });
    expect(resumeSop).toHaveBeenCalledOnce();
    expect(resumeSop).toHaveBeenCalledWith(payload);
  });

  it.each([
    ['SOP_SESSION_NOT_FOUND', 404],
    ['SOP_WAIT_STALE', 409],
    ['SOP_REVISION_CONFLICT', 409],
    ['SESSION_BUSY', 409],
    ['SOP_MODULE_DISABLED', 501],
  ])('maps %s to HTTP %i', async (code, expectedStatus) => {
    const { createSopRouter } = await import('./sop.js');
    const app = express();
    app.use(express.json());
    app.use('/api/sop', createSopRouter({
      getGateway: async () => ({ resumeSop: async () => { throw Object.assign(new Error(code), { code }); } }),
    }));

    const response = await request(app, '/api/sop/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: 's', requestId: 'r', waitId: 'w', source: 'human', message: 'done' }),
    });

    expect(response).toEqual({ status: expectedStatus, body: { error: { code, message: code } } });
  });

  it('rejects malformed resume input before opening a Gateway connection', async () => {
    const getGateway = vi.fn();
    const { createSopRouter } = await import('./sop.js');
    const app = express();
    app.use(express.json());
    app.use('/api/sop', createSopRouter({ getGateway }));

    const response = await request(app, '/api/sop/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'robot' }),
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(getGateway).not.toHaveBeenCalled();
  });
});
