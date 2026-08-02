import express from 'express';
import bcrypt from 'bcrypt';
import { instancesDb, userDb, db } from '../database/db.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clearSessionCookie,
  createBrowserSession,
  isAuthEnabled,
  isLoopbackRequest,
  recordAudit,
  registerLoginFailure,
  revokeRequestSession,
  rotateCsrfForSession,
  sanitizeUser,
  setAuthEnabled,
  setSessionCookie,
} from '../services/auth-service.js';

const router = express.Router();
const PASSWORD_MIN_LENGTH = 10;

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return null;
}

function completeLogin(req, res, user, eventType = 'auth.login') {
  const { token, csrfToken, session } = createBrowserSession(req, user);
  setSessionCookie(req, res, token);
  userDb.updateLastLogin(user.id);
  recordAudit(req, {
    actorUserId: user.id,
    eventType,
    targetType: 'auth_session',
    targetId: session.id,
  });
  return res.json({ success: true, user: sanitizeUser(user), csrfToken });
}

router.get('/status', (req, res) => {
  try {
    const enabled = isAuthEnabled();
    const hasUsers = userDb.hasUsers();
    const localUser = !enabled ? userDb.getFirstUser() : null;
    return res.json({
      authEnabled: enabled,
      authDisabled: !enabled,
      needsSetup: enabled && !hasUsers,
      isAuthenticated: !enabled,
      localUser: localUser ? sanitizeUser(localUser) : null,
    });
  } catch (error) {
    console.error('Auth status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Compatibility setup for deployments that require authentication from the
// first boot. Normal local installs already have a migrated local owner and use
// /enable from Settings instead.
router.post('/register', async (req, res) => {
  if (!isAuthEnabled()) {
    return res.status(403).json({ error: 'Use Settings to enable multi-user login.' });
  }
  const { displayName = 'Owner', password } = req.body || {};
  const username = 'owner';
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (userDb.hasUsers()) return res.status(403).json({ error: 'The owner account already exists.' });

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = userDb.createUser(username, passwordHash, { displayName, systemRole: 'owner' });
    instancesDb.ensureLocalForUser(user);
    return completeLogin(req, res, user, 'auth.owner_created');
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500).json({
      error: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Username already exists.' : 'Internal server error',
    });
  }
});

router.post('/enable', async (req, res) => {
  if (isAuthEnabled()) return res.status(409).json({ error: 'Multi-user login is already enabled.' });
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({
      error: 'Initial enablement is restricted to localhost. Use the offline CLI on remote deployments.',
    });
  }
  const { displayName = 'Owner', password } = req.body || {};
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  const current = userDb.getFirstUser();
  if (!current) return res.status(409).json({ error: 'The local owner has not been initialized yet.' });

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const ownerConflict = db.prepare(`SELECT id FROM users WHERE username = 'owner' AND id <> ?`).get(current.id);
    if (ownerConflict) return res.status(409).json({ error: 'An owner username already exists.' });
    const owner = userDb.setUsernameAndOwnerProfile(current.id, { displayName, passwordHash });
    instancesDb.ensureLocalForUser(owner);
    setAuthEnabled(true);
    return completeLogin(req, res, owner, 'auth.enabled');
  } catch (error) {
    console.error('Enable auth error:', error);
    return res.status(500).json({ error: 'Failed to enable multi-user login.' });
  }
});

router.post('/login', async (req, res) => {
  if (!isAuthEnabled()) {
    return res.status(403).json({ error: 'Login is disabled for this local installation.' });
  }
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const limit = checkLoginRateLimit(req, username);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    recordAudit(req, { eventType: 'auth.login_rate_limited', targetType: 'user', targetId: username, outcome: 'blocked' });
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  try {
    const user = userDb.getUserByUsername(username);
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!valid) {
      registerLoginFailure(req, username);
      recordAudit(req, { eventType: 'auth.login_failed', targetType: 'user', targetId: username, outcome: 'failure' });
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    clearLoginFailures(req, username);
    instancesDb.ensureLocalForUser(user);
    return completeLogin(req, res, user);
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/user', authenticateToken, (req, res) => {
  const csrfToken = req.authSession ? rotateCsrfForSession(req.authSession.id) : null;
  return res.json({ user: req.user, csrfToken });
});

router.post('/logout', authenticateToken, (req, res) => {
  const verified = revokeRequestSession(req);
  clearSessionCookie(req, res);
  recordAudit(req, {
    eventType: 'auth.logout',
    targetType: 'auth_session',
    targetId: verified?.session?.id,
  });
  return res.json({ success: true });
});

router.post('/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const passwordError = validatePassword(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const stored = userDb.getUserByUsername(req.user.username);
  if (!stored || !await bcrypt.compare(String(currentPassword || ''), stored.password_hash)) {
    recordAudit(req, { eventType: 'auth.password_change_failed', targetType: 'user', targetId: req.user.id, outcome: 'failure' });
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  userDb.updatePassword(req.user.id, hash, false);
  // Keep the current device, revoke all others.
  const { authSessionsDb } = await import('../database/db.js');
  authSessionsDb.revokeForUser(req.user.id, req.authSession?.id || null);
  recordAudit(req, { eventType: 'auth.password_changed', targetType: 'user', targetId: req.user.id });
  return res.json({ success: true, user: sanitizeUser(userDb.getUserById(req.user.id)) });
});

export default router;
