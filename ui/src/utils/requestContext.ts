type ClientRequestContext = { deviceId?: string; clientVersion: string; requestId?: string };
const version = import.meta.env.VITE_PILOTDECK_VERSION || '0.0.0';
let headersMode = import.meta.env.VITE_PILOTDECK_REQUEST_HEADERS || 'full';
export function rememberRequestHeadersMode(value: string | null) {
  if (value === 'full' || value === 'basic' || value === 'off') headersMode = value;
}
let memoryDeviceId: string | undefined;
let knownUser: { token: string | null; id: string } | undefined;
const knownProjects = new Map<string, { token: string | null; id: string }>();
function projectKey(target: URL, body?: unknown): string | undefined {
  let data: Record<string, unknown> = {};
  if (typeof body === 'string') { try { data = JSON.parse(body) ?? {}; } catch { /* not JSON */ } }
  const path = data.projectPath || target.searchParams.get('projectPath');
  const name = data.projectName || target.searchParams.get('projectName') || target.pathname.match(/^\/api\/projects\/([^/]+)/)?.[1];
  return typeof path === 'string' ? `path:${path}` : typeof name === 'string' ? `name:${name}` : undefined;
}
const uuid = (): string | undefined => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return undefined;
  // randomUUID is restricted to secure contexts; getRandomValues also works on LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function clientRequestContext(): ClientRequestContext {
  if (headersMode !== 'full') return { clientVersion: version, requestId: uuid() };
  try {
    const stored = localStorage.getItem('pilotdeck-device-id');
    if (stored && /^[0-9a-f-]{36}$/i.test(stored)) memoryDeviceId = stored;
    memoryDeviceId ??= uuid();
    if (memoryDeviceId) localStorage.setItem('pilotdeck-device-id', memoryDeviceId);
  } catch { memoryDeviceId ??= uuid(); }
  return { deviceId: memoryDeviceId, clientVersion: version, requestId: uuid() };
}

/** Only our same-origin API receives diagnostics; no global selected-session state. */
export function clientRequestHeaders(url: string, body?: unknown): Record<string, string> {
  if (headersMode === 'off') return {};
  let target: URL;
  try { target = new URL(url, window.location.href); } catch { return {}; }
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) return {};
  const context = clientRequestContext();
  const headers: Record<string, string> = {
    'x-pilotdeck-client': window.pilotdeckDesktop ? 'desktop' : 'web',
    'x-pilotdeck-version': version,
    'x-pilotdeck-schema-version': '1',
  };
  if (context.requestId) headers['x-pilotdeck-request-id'] = context.requestId;
  if (context.deviceId) headers['x-pilotdeck-device-id'] = context.deviceId;
  if (headersMode !== 'full') return headers;
  const project = projectKey(target, body);
  const knownProject = project ? knownProjects.get(project) : undefined;
  if (knownProject && knownProject.token === requestAuthToken()) headers['x-pilotdeck-project-id'] = knownProject.id;
  try {
    if (knownUser && knownUser.token === localStorage.getItem('auth-token')) headers['x-pilotdeck-user-id'] = knownUser.id;
  } catch { /* storage unavailable */ }
  let data: Record<string, unknown> = {};
  if (typeof body === 'string') {
    try { data = JSON.parse(body) ?? {}; } catch { /* not JSON */ }
  }
  const session = data.sessionId || target.searchParams.get('sessionId') || target.pathname.match(/^\/api\/sessions\/([^/]+)/)?.[1];
  // Only opaque UUIDs leave the browser. Named/channel session keys are
  // anonymized by the server after it resolves the request's actual context.
  if (typeof session === 'string' && /^[0-9a-f-]{36}$/i.test(session)) headers['x-pilotdeck-session-id'] = session;
  return headers;
}

export function requestAuthToken(): string | null {
  try { return localStorage.getItem('auth-token'); } catch { return null; }
}

export function rememberRequestUser(url: string, response: Response, body?: unknown, dispatchedToken = requestAuthToken()) {
  try {
    const target = new URL(url, window.location.href);
    if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) return;
    rememberRequestHeadersMode(response.headers.get('x-pilotdeck-request-headers-mode'));
    if (!response.ok || dispatchedToken !== requestAuthToken()) return;
    const id = response.headers.get('x-pilotdeck-user-id');
    if (id && /^[0-9a-f]{32}$/.test(id)) knownUser = { token: dispatchedToken, id };
    const project = projectKey(target, body);
    const projectId = response.headers.get('x-pilotdeck-project-id');
    if (project && projectId && /^[0-9a-f]{32}$/.test(projectId)) {
      knownProjects.set(project, { token: dispatchedToken, id: projectId });
      if (knownProjects.size > 128) knownProjects.delete(knownProjects.keys().next().value!);
    }
  } catch { /* diagnostics never fail the API request */ }
}

export function withClientRequestContext(message: any) {
  if (headersMode === 'off') return message;
  return { ...message, requestContext: clientRequestContext() };
}
