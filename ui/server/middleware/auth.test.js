import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('group delegation authentication', () => {
  it('accepts only a valid turn-scoped room grant', async () => {
    const verifyGrant = vi.fn((token, roomId) => token === 'scoped-secret' && roomId === 'room-1'
      ? { id: 'grant-1', room_id: roomId, turn_id: 'turn-1' }
      : null);
    vi.doMock('../services/group-delegation-grants.js', () => ({ verifyGroupDelegationGrant: verifyGrant }));
    vi.doMock('../services/auth-service.js', () => ({
      isAuthEnabled: () => true,
      sanitizeUser: (user) => user,
      verifyCsrf: () => true,
      verifyRequestSession: () => null,
      verifyBrowserSessionToken: () => null,
    }));
    vi.doMock('../database/db.js', () => ({
      appConfigDb: { getOrCreateJwtSecret: () => 'jwt-secret' },
      userDb: { getFirstUser: () => null },
    }));
    vi.doMock('../constants/config.js', () => ({ IS_PLATFORM: false }));
    const { authenticateGroupDelegation } = await import('./auth.js');
    const app = express();
    app.post('/api/groups/:groupId/delegate', authenticateGroupDelegation, (req, res) => {
      res.json({ authenticated: req.groupDelegationAuthenticated === true, turnId: req.groupDelegationGrant.turn_id });
    });
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const accepted = await nativeFetch(`http://127.0.0.1:${port}/api/groups/room-1/delegate`, {
        method: 'POST',
        headers: { 'X-PilotDeck-Delegation-Token': 'scoped-secret' },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ authenticated: true, turnId: 'turn-1' });

      const rejected = await nativeFetch(`http://127.0.0.1:${port}/api/groups/room-1/delegate`, {
        method: 'POST',
        headers: { 'X-PilotDeck-Delegation-Token': 'wrong-secret' },
      });
      expect(rejected.status).toBe(403);
      expect(verifyGrant).toHaveBeenCalledWith('wrong-secret', 'room-1');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
