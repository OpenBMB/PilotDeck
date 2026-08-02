import jwt from 'jsonwebtoken';
import { userDb, appConfigDb } from '../database/db.js';
import { IS_PLATFORM } from '../constants/config.js';
import {
  isAuthEnabled,
  sanitizeUser,
  verifyCsrf,
  verifyRequestSession,
  verifyBrowserSessionToken,
} from '../services/auth-service.js';
import { verifyGroupDelegationGrant } from '../services/group-delegation-grants.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

function extractDashboardRefererToken(req) {
  const refererHeader = req.headers.referer || req.headers.referrer;
  if (!refererHeader || Array.isArray(refererHeader)) {
    return null;
  }

  try {
    const refererUrl = new URL(
      refererHeader,
      `${req.protocol}://${req.get('host')}`,
    );
    if (!refererUrl.pathname.startsWith('/memory-dashboard')) {
      return null;
    }
    return refererUrl.searchParams.get('token');
  } catch {
    return null;
  }
}

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode and the default local mode keep the original single-user
  // experience. The database flag can switch this path immediately at runtime.
  if (IS_PLATFORM || !isAuthEnabled()) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'No user found in database (restart server after DB init)' });
      }
      req.user = sanitizeUser(user);
      req.authMethod = IS_PLATFORM ? 'platform' : 'local-bypass';
      return next();
    } catch (error) {
      console.error('Auth bypass mode error:', error);
      return res.status(500).json({ error: 'Failed to fetch user' });
    }
  }

  const verified = verifyRequestSession(req);
  if (!verified) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!verifyCsrf(req, verified.session)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.', code: 'CSRF_REQUIRED' });
  }
  req.user = verified.user;
  req.authSession = verified.session;
  req.authMethod = verified.authMethod;
  return next();
};

// The gateway process uses this narrow authentication path when a persistent
// group's main agent delegates to another member. Reuse the local gateway
// server token instead of requiring a browser JWT.
const authenticateGroupDelegation = async (req, res, next) => {
  const supplied = req.headers['x-pilotdeck-delegation-token'];
  if (typeof supplied !== 'string' || !supplied) {
    return res.status(401).json({ error: 'Missing group delegation token.' });
  }
  const roomId = req.params.groupId || decodeURIComponent(String(req.path || '').split('/').filter(Boolean)[0] || '');
  const grant = verifyGroupDelegationGrant(supplied, roomId);
  if (!grant) {
    return res.status(403).json({ error: 'Invalid group delegation token.' });
  }
  req.groupDelegationAuthenticated = true;
  req.groupDelegationGrant = grant;
  return next();
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (requestOrToken) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM || !isAuthEnabled()) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  if (requestOrToken && typeof requestOrToken === 'object' && requestOrToken.headers) {
    const origin = requestOrToken.headers.origin;
    const host = requestOrToken.headers.host;
    if (!origin || !host) return null;
    try {
      if (new URL(origin).host !== host) return null;
    } catch {
      return null;
    }
    const verified = verifyRequestSession(requestOrToken);
    return verified
      ? { ...verified.user, userId: verified.user.id, authSessionId: verified.session.id }
      : null;
  }
  // Kept only for callers passing an already extracted cookie value.
  const verified = verifyBrowserSessionToken(requestOrToken);
  return verified
    ? { ...verified.user, userId: verified.user.id, authSessionId: verified.session.id }
    : null;
};

const requireSystemRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.systemRole)) {
    return res.status(403).json({ error: 'Insufficient system permissions.' });
  }
  return next();
};

export {
  validateApiKey,
  authenticateGroupDelegation,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  requireSystemRole,
  JWT_SECRET
};
