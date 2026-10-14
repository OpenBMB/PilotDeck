import { DatabaseSync } from 'node:sqlite';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Web issues HS256 installation JWTs. Keep Gateway verification dependency-free.
function verifyOwnerToken(bearer, secret) {
  const parts = bearer.split('.');
  if (parts.length !== 3 || !secret) throw new Error('Invalid JWT');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (header.alg !== 'HS256') throw new Error('Unsupported JWT');
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const signature = Buffer.from(parts[2], 'base64url');
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error('Invalid JWT');
  const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  if ((value.exp !== undefined && (typeof value.exp !== 'number' || value.exp <= now))
    || (value.nbf !== undefined && (typeof value.nbf !== 'number' || value.nbf > now))) throw new Error('Expired JWT');
  return value;
}

/** Verify the same installation JWT as Web, without starting a Web or SD server. */
export function createPilotDeckApprovalAuthority({ databasePath, jwtSecret, readOwner }) {
  return {
    async authenticate({ bearer, signal }) {
      signal?.throwIfAborted();
      let db;
      try {
        db = new DatabaseSync(databasePath, { readOnly: true });
        const secret = jwtSecret || db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get()?.value;
        const decoded = verifyOwnerToken(bearer, secret);
        const ownerId = readOwner();
        if (!ownerId || String(decoded.userId) !== ownerId) throw new Error('owner');
        return { tenantId: 'pilotdeck', userId: ownerId, source: 'web', role: 'admin', disabled: false };
      } catch {
        throw Object.assign(new Error('PilotDeck owner authentication required'), { code: 'APPROVAL_AUTH_REJECTED', status: 401 });
      } finally { db?.close(); }
    },
  };
}
