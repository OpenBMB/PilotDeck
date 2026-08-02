import crypto from 'node:crypto';
import { groupDelegationGrantsDb } from '../database/db.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sqliteDate = (date) => date.toISOString().replace('T', ' ').replace('Z', '');

export function createGroupDelegationGrant({ roomId, turnId, entryInstanceId, ttlMs = 10 * 60_000 }) {
  const token = crypto.randomBytes(48).toString('base64url');
  const id = crypto.randomUUID();
  groupDelegationGrantsDb.create({
    id,
    tokenHash: hash(token),
    roomId,
    turnId,
    entryInstanceId,
    expiresAt: sqliteDate(new Date(Date.now() + ttlMs)),
  });
  groupDelegationGrantsDb.deleteExpired();
  return { id, token };
}

export function verifyGroupDelegationGrant(token, roomId) {
  if (!token) return null;
  const grant = groupDelegationGrantsDb.getByTokenHash(hash(String(token)));
  if (!grant || grant.room_id !== roomId || Date.parse(`${grant.expires_at}Z`) <= Date.now()) return null;
  groupDelegationGrantsDb.markUsed(grant.id);
  return grant;
}

export function revokeGroupDelegationGrants(turnId) {
  groupDelegationGrantsDb.revokeForTurn(turnId);
}
