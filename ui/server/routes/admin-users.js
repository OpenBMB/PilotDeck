import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcrypt';
import { auditEventsDb, authSessionsDb, instancesDb, userDb } from '../database/db.js';
import { recordAudit, sanitizeUser } from '../services/auth-service.js';

const router = express.Router();
const VALID_ROLES = new Set(['admin', 'member']);

function canManageTarget(actor, target) {
  if (!target || target.system_role === 'owner') return false;
  if (actor.systemRole === 'owner') return true;
  return actor.systemRole === 'admin' && target.system_role === 'member';
}

function generateTemporaryPassword() {
  return `Pd-${crypto.randomBytes(15).toString('base64url')}!`;
}

router.get('/users', (req, res) => {
  return res.json({ users: userDb.listUsers().map(sanitizeUser) });
});

router.post('/users', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const displayName = String(req.body?.displayName || username).trim();
  const requestedRole = String(req.body?.systemRole || 'member');
  const systemRole = req.user.systemRole === 'owner' && VALID_ROLES.has(requestedRole)
    ? requestedRole
    : 'member';
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-64 letters, numbers, dots, dashes or underscores.' });
  }
  if (!displayName || displayName.length > 100) return res.status(400).json({ error: 'Invalid display name.' });
  const temporaryPassword = generateTemporaryPassword();
  try {
    const hash = await bcrypt.hash(temporaryPassword, 12);
    const user = userDb.createUser(username, hash, { displayName, systemRole, mustChangePassword: true });
    instancesDb.ensureLocalForUser(user);
    recordAudit(req, { eventType: 'admin.user_created', targetType: 'user', targetId: user.id, metadata: { systemRole } });
    return res.status(201).json({ user: sanitizeUser(user), temporaryPassword });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username already exists.' });
    console.error('Create user error:', error);
    return res.status(500).json({ error: 'Failed to create user.' });
  }
});

router.patch('/users/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const target = userDb.getUserById(userId, { includeInactive: true });
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!canManageTarget(req.user, target)) return res.status(403).json({ error: 'This account cannot be modified.' });

  let updated = target;
  if (req.body?.systemRole != null) {
    const role = String(req.body.systemRole);
    if (!VALID_ROLES.has(role) || (req.user.systemRole !== 'owner' && role !== 'member')) {
      return res.status(403).json({ error: 'You cannot assign that role.' });
    }
    updated = userDb.updateRole(userId, role);
  }
  if (req.body?.isActive != null) {
    updated = userDb.setActive(userId, Boolean(req.body.isActive));
    if (!req.body.isActive) authSessionsDb.revokeForUser(userId);
  }
  recordAudit(req, {
    eventType: 'admin.user_updated', targetType: 'user', targetId: userId,
    metadata: { systemRole: req.body?.systemRole, isActive: req.body?.isActive },
  });
  return res.json({ user: sanitizeUser(updated) });
});

router.post('/users/:userId/reset-password', async (req, res) => {
  const userId = Number(req.params.userId);
  const target = userDb.getUserById(userId, { includeInactive: true });
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!canManageTarget(req.user, target)) return res.status(403).json({ error: 'This password cannot be reset.' });
  const temporaryPassword = generateTemporaryPassword();
  const hash = await bcrypt.hash(temporaryPassword, 12);
  userDb.updatePassword(userId, hash, true);
  authSessionsDb.revokeForUser(userId);
  recordAudit(req, { eventType: 'admin.password_reset', targetType: 'user', targetId: userId });
  return res.json({ success: true, temporaryPassword });
});

router.post('/users/:userId/revoke-sessions', (req, res) => {
  const userId = Number(req.params.userId);
  const target = userDb.getUserById(userId, { includeInactive: true });
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id !== Number(req.user.id) && !canManageTarget(req.user, target)) {
    return res.status(403).json({ error: 'This account cannot be modified.' });
  }
  authSessionsDb.revokeForUser(userId);
  recordAudit(req, { eventType: 'admin.sessions_revoked', targetType: 'user', targetId: userId });
  return res.json({ success: true });
});

router.get('/audit-events', (req, res) => {
  return res.json({ events: auditEventsDb.list({ limit: req.query.limit, offset: req.query.offset }) });
});

export default router;
