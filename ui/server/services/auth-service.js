import crypto from 'node:crypto';
import { appConfigDb, auditEventsDb, authSessionsDb, userDb } from '../database/db.js';
import { IS_PLATFORM } from '../constants/config.js';

export const AUTH_COOKIE_NAME = 'pilotdeck_session';
export const AUTH_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const touchTimes = new Map();
const loginAttempts = new Map();

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const toSqliteDate = (date) => date.toISOString().replace('T', ' ').replace('Z', '');
const readEnvBoolean = (value) => {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'required', 'enabled', 'multi-user'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'disabled', 'local', 'off'].includes(normalized)) return false;
  return null;
};

export function isAuthEnabled() {
  if (IS_PLATFORM) return false;
  const mode = readEnvBoolean(process.env.PILOTDECK_AUTH_MODE);
  if (mode != null) return mode;
  if (Object.prototype.hasOwnProperty.call(process.env, 'PILOTDECK_DISABLE_LOCAL_AUTH')) {
    const disabled = readEnvBoolean(process.env.PILOTDECK_DISABLE_LOCAL_AUTH);
    return disabled == null ? false : !disabled;
  }
  return appConfigDb.get('auth_enabled') === 'true';
}

export function setAuthEnabled(enabled) {
  appConfigDb.set('auth_enabled', enabled ? 'true' : 'false');
}

export function sanitizeUser(user) {
  if (!user) return null;
  return {
    // Joined auth-session rows contain both the session id and user_id.
    // Authentication identity must always use the database user id.
    id: user.user_id ?? user.id,
    username: user.username,
    displayName: user.display_name || user.displayName || user.username,
    systemRole: user.system_role || user.systemRole || 'member',
    mustChangePassword: Boolean(user.must_change_password ?? user.mustChangePassword),
    isActive: Boolean(user.is_active ?? user.isActive ?? true),
    createdAt: user.created_at || user.createdAt,
    updatedAt: user.updated_at || user.updatedAt,
    lastLogin: user.last_login || user.lastLogin,
  };
}

export function parseCookies(header = '') {
  return String(header).split(';').reduce((cookies, entry) => {
    const index = entry.indexOf('=');
    if (index <= 0) return cookies;
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
    return cookies;
  }, {});
}

export function getRequestIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

export function hashRequestIp(req) {
  const salt = appConfigDb.getOrCreateJwtSecret();
  return sha256(`${salt}:${getRequestIp(req)}`);
}

export function isLoopbackRequest(req) {
  const ip = getRequestIp(req).replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function cookieAttributes(req, maxAgeSeconds) {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = Boolean(req.secure) || forwardedProto === 'https';
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

export function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes(req, Math.floor(AUTH_ABSOLUTE_MS / 1000))}`);
}

export function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; ${cookieAttributes(req, 0)}`);
}

export function createBrowserSession(req, user) {
  const token = crypto.randomBytes(48).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const session = authSessionsDb.create({
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash: sha256(token),
    csrfHash: sha256(csrfToken),
    idleExpiresAt: toSqliteDate(new Date(now + AUTH_IDLE_MS)),
    absoluteExpiresAt: toSqliteDate(new Date(now + AUTH_ABSOLUTE_MS)),
    userAgent: String(req.headers?.['user-agent'] || '').slice(0, 500),
    ipHash: hashRequestIp(req),
  });
  authSessionsDb.deleteExpired();
  return { token, csrfToken, session };
}

export function verifyBrowserSessionToken(rawToken, { touch = true } = {}) {
  if (!rawToken) return null;
  const record = authSessionsDb.getByTokenHash(sha256(rawToken));
  if (!record || record.revoked_at || !record.is_active) return null;
  const now = Date.now();
  const idleExpires = Date.parse(`${record.idle_expires_at}Z`);
  const absoluteExpires = Date.parse(`${record.absolute_expires_at}Z`);
  if (!Number.isFinite(idleExpires) || !Number.isFinite(absoluteExpires)
      || idleExpires <= now || absoluteExpires <= now) {
    authSessionsDb.revoke(record.id);
    return null;
  }
  if (touch && (touchTimes.get(record.id) || 0) < now - 60_000) {
    const nextIdle = Math.min(now + AUTH_IDLE_MS, absoluteExpires);
    authSessionsDb.touch(record.id, toSqliteDate(new Date(nextIdle)));
    touchTimes.set(record.id, now);
  }
  return {
    session: record,
    user: sanitizeUser(record),
  };
}

export function verifyRequestSession(req, options = {}) {
  const cookies = parseCookies(req.headers?.cookie);
  const rawToken = cookies[AUTH_COOKIE_NAME];
  const verified = verifyBrowserSessionToken(rawToken, options);
  if (!verified) return null;
  return { ...verified, rawToken, authMethod: 'cookie' };
}

export function verifyCsrf(req, session) {
  if (!UNSAFE_METHODS.has(String(req.method || '').toUpperCase())) return true;
  const supplied = req.headers?.['x-csrf-token'];
  if (typeof supplied !== 'string' || !supplied) return false;
  const actual = Buffer.from(sha256(supplied));
  const expected = Buffer.from(session.csrf_hash || '');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function issueFreshCsrf(sessionId) {
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const csrfHash = sha256(csrfToken);
  // Updating the hash intentionally invalidates a CSRF value copied from an
  // older browser response without forcing the login session itself to rotate.
  // The normal /auth/user response simply returns a stable request-scoped
  // value via rotateCsrfForSession below.
  return { csrfToken, csrfHash, sessionId };
}

export function rotateCsrfForSession(sessionId) {
  const { csrfToken, csrfHash } = issueFreshCsrf(sessionId);
  const result = authSessionsDb.getById(sessionId);
  if (!result || result.revoked_at) return null;
  // better-sqlite3 connection remains deliberately encapsulated elsewhere;
  // expose the narrow update through this module's imported database helper.
  authSessionsDb.updateCsrf(sessionId, csrfHash);
  return csrfToken;
}

export function revokeRequestSession(req) {
  const verified = verifyRequestSession(req, { touch: false });
  if (verified) authSessionsDb.revoke(verified.session.id);
  return verified;
}

export function recordAudit(req, event) {
  try {
    auditEventsDb.create({
      ...event,
      actorUserId: event.actorUserId ?? req.user?.id ?? null,
      ipHash: hashRequestIp(req),
    });
  } catch (error) {
    console.warn('[auth] Failed to record audit event:', error.message);
  }
}

export function checkLoginRateLimit(req, username) {
  const key = `${String(username || '').toLowerCase()}:${hashRequestIp(req)}`;
  const now = Date.now();
  const current = loginAttempts.get(key) || [];
  const recent = current.filter((timestamp) => timestamp > now - 15 * 60_000);
  loginAttempts.set(key, recent);
  if (recent.length < 8) return { allowed: true };
  const retryAfter = Math.max(1, Math.ceil((recent[0] + 15 * 60_000 - now) / 1000));
  return { allowed: false, retryAfter };
}

export function registerLoginFailure(req, username) {
  const key = `${String(username || '').toLowerCase()}:${hashRequestIp(req)}`;
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((timestamp) => timestamp > now - 15 * 60_000);
  recent.push(now);
  loginAttempts.set(key, recent);
}

export function clearLoginFailures(req, username) {
  loginAttempts.delete(`${String(username || '').toLowerCase()}:${hashRequestIp(req)}`);
}

export function ensureLocalInstance(user) {
  // Lazy import avoidance is unnecessary because db.js owns no auth imports.
  return userDb.getUserById(user.id) || user;
}
