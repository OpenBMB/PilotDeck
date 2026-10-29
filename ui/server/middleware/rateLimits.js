import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

// These are per-process admission budgets, not timeouts for active streams.
// A 500-image preview batch plus polling across several tabs fits the API budget.
export const RATE_LIMIT_DEFAULTS = Object.freeze({ ingress: 6000, user: 1200, auth: 20, model: 30 });
const readLimit = (env, name, fallback) => {
  const value = Number(env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value : fallback;
};
export const clientRateKey = req => ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown');
export const userRateKey = req => req.user?.id != null ? `user:${req.user.id}` : `ip:${clientRateKey(req)}`;

export function createRequestLimiters({ env = process.env, windowMs = 60_000 } = {}) {
  const counted = Symbol('authenticated API request counted');
  const common = { windowMs, standardHeaders: 'draft-8', legacyHeaders: false };
  const message = scope => ({ code: 'RATE_LIMITED', error: `Too many ${scope} requests. Please retry after the Retry-After interval.` });
  return {
    // Before body parsing, authentication, filesystem lookups and model dispatch.
    ingress: rateLimit({ ...common, identifier: 'api-ingress', keyGenerator: clientRateKey,
      limit: readLimit(env, 'PILOTDECK_API_IP_LIMIT', RATE_LIMIT_DEFAULTS.ingress), message: message('API') }),
    user: rateLimit({ ...common, identifier: 'api-user', keyGenerator: userRateKey,
      limit: readLimit(env, 'PILOTDECK_API_USER_LIMIT', RATE_LIMIT_DEFAULTS.user), message: message('API'),
      skip: req => { if (req[counted]) return true; req[counted] = true; return false; } }),
    auth: rateLimit({ ...common, identifier: 'auth-attempts', keyGenerator: clientRateKey,
      limit: readLimit(env, 'PILOTDECK_AUTH_ATTEMPT_LIMIT', RATE_LIMIT_DEFAULTS.auth),
      skipSuccessfulRequests: true, message: message('authentication') }),
    model: rateLimit({ ...common, identifier: 'http-model-tasks', keyGenerator: userRateKey,
      limit: readLimit(env, 'PILOTDECK_HTTP_MODEL_LIMIT', RATE_LIMIT_DEFAULTS.model), message: message('model task') }),
  };
}

export const requestLimiters = createRequestLimiters();
