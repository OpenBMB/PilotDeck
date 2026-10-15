import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PublicHostCapabilityProvider, PublicHostPrincipal } from './nativeHostCapabilityProvider.js';
import { encodeHostCapabilityStream, isHostCapabilityStreamBody, PUBLIC_HOST_WIRE_HEADERS, PUBLIC_HOST_WIRE_OPERATIONS } from './publicHostWire.js';

export type PublicHostProviderResolver = (principal: PublicHostPrincipal) => PublicHostCapabilityProvider | Promise<PublicHostCapabilityProvider>;

/** Application transport on the existing authenticated Gateway HTTP server. */
export async function handlePublicHostHttpRequest(req: IncomingMessage, res: ServerResponse, options: { token: string; resolve?: PublicHostProviderResolver }): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path !== '/api/module-host/describe' && path !== '/api/module-host/call') return false;
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${options.token}`) { send(401, { code: 'PUBLIC_HOST_TRANSPORT_UNAUTHORIZED' }); return true; }
  if (req.method !== 'POST') { send(405, { code: 'PUBLIC_HOST_METHOD_NOT_ALLOWED' }); return true; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    if (!options.resolve) { send(501, { code: 'PUBLIC_HOST_PORT_UNAVAILABLE' }); return true; }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > 32 * 1024 * 1024) { send(413, { code: 'PUBLIC_HOST_INPUT_TOO_LARGE' }); return true; }
      chunks.push(buffer);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { code: 'PUBLIC_HOST_INPUT_INVALID' }); return true; }
    const principal = input?.principal;
    if (!principal || !['pilotDeckUserId', 'tenantId', 'actorUserId'].every(name => typeof principal[name] === 'string' && principal[name].trim())
        || principal.agentId !== undefined && (typeof principal.agentId !== 'string' || !principal.agentId.trim())) {
      send(400, { code: 'PUBLIC_HOST_PRINCIPAL_REQUIRED' }); return true;
    }
    const provider = await options.resolve(principal);
    const operations = provider.operations.filter(operation => PUBLIC_HOST_WIRE_OPERATIONS.includes(operation));
    if (path.endsWith('/describe')) { send(200, { operations }); return true; }
    if (!operations.includes(input.operation)) { send(409, { code: 'PILOTDECK_HOST_CAPABILITY_UNAVAILABLE' }); return true; }
    if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) { send(400, { code: 'PUBLIC_HOST_INPUT_INVALID' }); return true; }
    if (['tenantId', 'tenant_id', 'actorUserId', 'actor_user_id', 'credentialId', 'agentId', 'agent_id'].some(name => Object.hasOwn(input.input, name))) {
      send(400, { code: 'PUBLIC_SCOPE_OVERRIDE' }); return true;
    }
    const response = await provider.call(input.operation, input.input, { principal, signal: controller.signal });
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw Object.assign(new Error('Invalid host status'), { status: 502 });
    const headers = new Headers(response.headers);
    res.statusCode = response.status;
    for (const header of PUBLIC_HOST_WIRE_HEADERS) if (headers.has(header)) res.setHeader(header, headers.get(header)!);
    const contentType = headers.get('content-type');
    if (isHostCapabilityStreamBody(response.body) && !contentType?.startsWith('application/x-ndjson') && !contentType?.startsWith('text/event-stream')) {
      throw Object.assign(new Error('Host stream content-type is required.'), { status: 502, code: 'PILOTDECK_HOST_RESPONSE_INVALID' });
    }
    if (contentType?.startsWith('application/x-ndjson') || contentType?.startsWith('text/event-stream')) {
      const body = response.body as AsyncIterable<unknown> & { getReader?: unknown };
      if (!body) throw Object.assign(new Error('Missing host stream'), { status: 502 });
      const source = typeof body.getReader === 'function' ? Readable.fromWeb(body as never) : body;
      res.flushHeaders();
      await pipeline(Readable.from(encodeHostCapabilityStream(source, contentType)), res, { signal: controller.signal });
    } else if ((response as typeof response & { rawBody?: string }).rawBody !== undefined) {
      res.end((response as typeof response & { rawBody?: string }).rawBody);
    } else if (response.body instanceof Uint8Array || (typeof response.body === 'string' && contentType && !contentType.includes('json'))) {
      res.end(response.body);
    } else {
      if (!contentType) res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response.body));
    }
  } catch (error) {
    if (controller.signal.aborted || res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); }
    else { const cause = error as { status?: number; code?: string; message?: string }; send(cause.status ?? 502, { code: cause.code ?? 'PUBLIC_HOST_TRANSPORT_FAILED', message: cause.message }); }
  } finally {
    req.removeListener('aborted', abort); res.removeListener('close', abort);
  }
  return true;
}
