// Host-header allowlist middleware.
//
// Defends against DNS-rebinding attacks: a page the user visits resolves an
// attacker-controlled hostname to the PilotDeck server's IP and, after the
// cache flips, issues same-origin requests carrying the user's session.
// Validating the Host header against an allowlist forces the browser-supplied
// hostname to match what the server was actually deployed under.
//
// Default OSS install runs with PILOTDECK_DISABLE_LOCAL_AUTH=true, so API
// routes accept any caller as the built-in local user — this guard is the
// last line of defense for that mode. Operators exposing the server on a LAN
// hostname or behind a reverse proxy can extend the allowlist via
// PILOTDECK_ALLOWED_HOSTS (comma-separated).

const LOOPBACK_NAMES = ['localhost', '0.0.0.0', '::', '::1', '[::1]'];

function parseHostOnly(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  // IPv6 literal form: [::1]:3001 or [::1]
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    return trimmed.slice(0, end + 1).toLowerCase();
  }
  // Multiple colons with no brackets => bare IPv6 literal (RFC says it
  // SHOULD be bracketed in Host headers but some clients send the bare form).
  const firstColon = trimmed.indexOf(':');
  if (firstColon === -1) return trimmed.toLowerCase();
  const lastColon = trimmed.lastIndexOf(':');
  if (firstColon !== lastColon) return trimmed.toLowerCase();
  return trimmed.slice(0, firstColon).toLowerCase();
}

function isLoopbackIPv4(host) {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function buildAllowedHosts(bindHost, extraList) {
  const set = new Set();
  for (const h of LOOPBACK_NAMES) set.add(h.toLowerCase());
  if (bindHost) {
    const b = String(bindHost).toLowerCase();
    // Skip wildcards in the bind-derived entry; they would defeat the guard
    // and the loopback names are already covered above.
    if (b !== '0.0.0.0' && b !== '::') set.add(b);
  }
  if (Array.isArray(extraList)) {
    for (const h of extraList) {
      const t = String(h || '').trim().toLowerCase();
      if (t) set.add(t);
    }
  }
  return set;
}

export function resolveAllowedHostsFromEnv(env = process.env) {
  const raw = env.PILOTDECK_ALLOWED_HOSTS;
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

export function hostGuardMiddleware({ bindHost, allowedHosts = [] } = {}) {
  const allowed = buildAllowedHosts(bindHost, allowedHosts);
  return function hostGuard(req, res, next) {
    const host = parseHostOnly(req.headers && req.headers.host);
    if (!host) {
      return res.status(403).json({
        error: 'FORBIDDEN_HOST',
        message: 'Missing Host header',
      });
    }
    if (isLoopbackIPv4(host) || allowed.has(host)) {
      return next();
    }
    return res.status(403).json({
      error: 'FORBIDDEN_HOST',
      message: `Host "${host}" is not in the allowlist. Set PILOTDECK_ALLOWED_HOSTS (comma-separated) to extend.`,
    });
  };
}
