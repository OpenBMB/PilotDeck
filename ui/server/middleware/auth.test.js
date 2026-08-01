import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.PILOTDECK_GATEWAY_TOKEN_PATH;
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('group delegation authentication', () => {
  it('accepts only the local gateway server token', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pilotdeck-group-auth-'));
    tempDirs.push(directory);
    const tokenPath = join(directory, 'server-token');
    writeFileSync(tokenPath, 'local-secret\n');
    process.env.PILOTDECK_GATEWAY_TOKEN_PATH = tokenPath;
    vi.doMock('../database/db.js', () => ({
      appConfigDb: { getOrCreateJwtSecret: () => 'jwt-secret' },
      userDb: {},
    }));
    vi.doMock('../constants/config.js', () => ({ IS_PLATFORM: false, DISABLE_LOCAL_AUTH: false }));
    const { authenticateGroupDelegation } = await import('./auth.js');
    const app = express();
    app.post('/delegate', authenticateGroupDelegation, (req, res) => {
      res.json({ authenticated: req.groupDelegationAuthenticated === true });
    });
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const accepted = await nativeFetch(`http://127.0.0.1:${port}/delegate`, {
        method: 'POST',
        headers: { 'X-PilotDeck-Group-Token': 'local-secret' },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ authenticated: true });

      const rejected = await nativeFetch(`http://127.0.0.1:${port}/delegate`, {
        method: 'POST',
        headers: { 'X-PilotDeck-Group-Token': 'wrong-secret' },
      });
      expect(rejected.status).toBe(403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
