import express from 'express';
import { authSessionsDb, userDb } from '../database/db.js';
import { clearSessionCookie, recordAudit, sanitizeUser } from '../services/auth-service.js';

const router = express.Router();

router.get('/', (req, res) => res.json({ user: sanitizeUser(userDb.getUserById(req.user.id)) }));

router.patch('/', (req, res) => {
  const displayName = String(req.body?.displayName || '').trim();
  if (!displayName || displayName.length > 100) {
    return res.status(400).json({ error: 'Display name must be between 1 and 100 characters.' });
  }
  const user = userDb.updateProfile(req.user.id, { displayName });
  recordAudit(req, { eventType: 'account.profile_updated', targetType: 'user', targetId: req.user.id });
  return res.json({ user: sanitizeUser(user) });
});

router.get('/sessions', (req, res) => {
  const sessions = authSessionsDb.listForUser(req.user.id).map((session) => ({
    id: session.id,
    createdAt: session.created_at,
    lastSeenAt: session.last_seen_at,
    idleExpiresAt: session.idle_expires_at,
    absoluteExpiresAt: session.absolute_expires_at,
    revokedAt: session.revoked_at,
    userAgent: session.user_agent,
    current: session.id === req.authSession?.id,
  }));
  return res.json({ sessions });
});

router.delete('/sessions/:sessionId', (req, res) => {
  const session = authSessionsDb.getById(req.params.sessionId);
  if (!session || session.user_id !== Number(req.user.id)) return res.status(404).json({ error: 'Session not found.' });
  authSessionsDb.revoke(session.id);
  if (session.id === req.authSession?.id) clearSessionCookie(req, res);
  recordAudit(req, { eventType: 'auth.session_revoked', targetType: 'auth_session', targetId: session.id });
  return res.json({ success: true, current: session.id === req.authSession?.id });
});

export default router;
