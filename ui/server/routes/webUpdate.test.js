// @vitest-environment node
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createWebUpdateRouter } from './webUpdate.js';

async function request(service, path, body) {
  const app = express(); app.use(express.json()); app.use(createWebUpdateRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: path === '/status' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, text: await response.text() };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

describe('web update API', () => {
  it('returns authoritative eligibility and disabled reason', async () => {
    const status = { canUpdate: false, hasUpdate: false, reason: 'development' };
    const result = await request({ check: async () => status }, '/check');
    expect(JSON.parse(result.text)).toEqual(status);
  });
  it('returns an HTTP refusal before streaming when preflight rejects the request', async () => {
    const apply = vi.fn(async () => { throw Object.assign(new Error('Local changes'), { reason: 'localChanges', statusCode: 409 }); });
    const target = { tagName: 'v2026.09.07', sourceSha: 'a'.repeat(40) };
    const result = await request({ apply }, '/apply', { target });
    expect(result.status).toBe(409);
    expect(JSON.parse(result.text)).toMatchObject({ reason: 'localChanges' });
    expect(apply).toHaveBeenCalledWith(target, expect.any(Function), undefined);
  });
  it('streams an explicit error terminal state after preparation fails', async () => {
    const apply = async (_target, progress) => { progress('Building'); throw Object.assign(new Error('Build failed'), { reason: 'buildFailed' }); };
    const result = await request({ apply }, '/apply', { target: {} });
    const lines = result.text.trim().split('\n').map(JSON.parse);
    expect(lines.at(-1)).toMatchObject({ status: 'error', reason: 'buildFailed' });
    expect(lines.some((line) => line.status === 'success')).toBe(false);
  });
  it('streams completion and preserves status recovery', async () => {
    const result = await request({ apply: async (_target, progress) => progress('Prepared') }, '/apply', { target: {} });
    expect(JSON.parse(result.text.trim().split('\n').at(-1))).toMatchObject({ stage: 'complete', status: 'success' });
    const status = { updateInProgress: false, lastUpdateResult: { success: true, needsRestart: true } };
    expect(JSON.parse((await request({ status: () => status }, '/status')).text)).toEqual(status);
  });
});
