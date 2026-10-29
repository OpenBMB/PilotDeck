import { randomUUID } from 'node:crypto';
import {
  anonymousRequestId, currentRequestContext, requestContextHeaders,
  safeHeaderValue, withRequestContext,
  requestHeadersMode,
} from '../../../src/network/requestContext.js';

export function authenticatedRequestContext(userId, client = {}) {
  if (!client || typeof client !== 'object') client = {};
  return {
    userId: ['off', 'basic'].includes(process.env.PILOTDECK_REQUEST_HEADERS) ? undefined : anonymousRequestId('user', userId == null ? 'local-profile' : String(userId)),
    deviceId: safeHeaderValue(client.deviceId),
    clientVersion: safeHeaderValue(client.clientVersion),
    parentRequestId: safeHeaderValue(client.requestId) ?? randomUUID(),
  };
}

export function createRequestContextMiddleware(resolveProject) {
  return (req, res, next) => {
    req.resolveRequestProject = resolveProject;
    requestContextMiddleware(req, res, next);
  };
}

export function requestContextMiddleware(req, res, next) {
  res.setHeader('x-pilotdeck-request-headers-mode', requestHeadersMode());
  const requestId = safeHeaderValue(req.headers['x-pilotdeck-request-id']) ?? randomUUID();
  const url = new URL(req.originalUrl || req.url, 'http://localhost');
  const session = url.pathname.match(/^\/api\/sessions\/([^/]+)/)?.[1];
  const string = value => typeof value === 'string' && value.length <= 4096 ? value : undefined;
  let decodedSession;
  try { decodedSession = session ? decodeURIComponent(session) : undefined; } catch { /* malformed URL */ }
  const context = {
    deviceId: safeHeaderValue(req.headers['x-pilotdeck-device-id']),
    clientVersion: safeHeaderValue(req.headers['x-pilotdeck-version']),
    parentRequestId: requestId,
    purpose: 'web-api',
    sessionId: string(req.body?.sessionId) || url.searchParams.get('sessionId') || decodedSession,
    projectPath: string(req.body?.projectPath) || url.searchParams.get('projectPath') || undefined,
  };
  // Headers are an allowlisted diagnostic view, never a source of authenticated identity.
  withRequestContext(context, () => {
    const headers = requestContextHeaders({}, { requestId, userAgent: false });
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    req.requestContext = { ...context, requestId };
    const projectName = string(req.body?.projectName) || url.searchParams.get('projectName');
    const routeProject = url.pathname.match(/^\/api\/projects\/([^/]+)/)?.[1];
    try { req.requestProjectName = projectName || (routeProject ? decodeURIComponent(routeProject) : undefined); } catch { /* malformed route */ }
    next();
  });
}

export async function withAuthenticatedRequest(req, res, next) {
  const context = {
    ...currentRequestContext(),
    ...authenticatedRequestContext(req.user?.id ?? req.user?.userId, req.requestContext),
  };
  if (requestHeadersMode() === 'full' && !context.projectPath && req.requestProjectName && req.resolveRequestProject) {
    try { context.projectPath = await req.resolveRequestProject(req.requestProjectName); } catch { /* optional diagnostics */ }
  }
  if (process.env.PILOTDECK_REQUEST_HEADERS !== 'off' && process.env.PILOTDECK_REQUEST_HEADERS !== 'basic') {
    res.setHeader('x-pilotdeck-user-id', context.userId);
    const projectId = requestContextHeaders(context, { userAgent: false })['x-pilotdeck-project-id'];
    if (projectId) res.setHeader('x-pilotdeck-project-id', projectId);
  }
  req.requestContext = context;
  return withRequestContext(context, next);
}
