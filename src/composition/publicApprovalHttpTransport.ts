import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PublicApprovalBridge } from './publicApprovalBridge.js';

export async function handlePublicApprovalHttpRequest(req: IncomingMessage, res: ServerResponse,
  options: { token: string; bridge?: PublicApprovalBridge }): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path !== '/api/module-host/approvals/status' && path !== '/api/module-host/approvals/resume') return false;
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!options.token || req.headers.authorization !== `Bearer ${options.token}`) { send(401, { code: 'PUBLIC_HOST_TRANSPORT_UNAUTHORIZED' }); return true; }
  if (req.method !== 'POST') { send(405, { code: 'PUBLIC_HOST_METHOD_NOT_ALLOWED' }); return true; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort); res.once('close', abort);
  try {
    if (!options.bridge) throw Object.assign(new Error('Approval binding unavailable'), { status: 503, code: 'APPROVAL_BINDING_UNAVAILABLE' });
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > 64 * 1024) throw Object.assign(new Error('Approval input too large'), { status: 413, code: 'APPROVAL_INPUT_TOO_LARGE' });
      chunks.push(buffer);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid approval input'), { status: 400, code: 'APPROVAL_INPUT_INVALID' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Invalid approval input'), { status: 400, code: 'APPROVAL_INPUT_INVALID' });
    const operation = path.endsWith('/status') ? 'status' : 'resume';
    const allowed = ['tenantId', 'agentId', 'sessionKey', 'projectKey', ...(operation === 'resume'
      ? ['source', 'requestId', 'waitId', 'expectedRevision', 'message', 'slotUpdates'] : [])];
    if (Object.keys(body).some(name => !allowed.includes(name))) throw Object.assign(new Error('Unexpected approval input'), { status: 400, code: 'APPROVAL_AUTHORITY_OVERRIDE' });
    if (!options.bridge.dynamicBinding && (body.tenantId !== options.bridge.binding.tenantId || body.agentId !== options.bridge.binding.agentId)) {
      throw Object.assign(new Error('Approval scope mismatch'), { status: 403, code: 'APPROVAL_SUBJECT_MISMATCH' });
    }
    const input = { ...body, approverAuthorization: req.headers['x-staffdeck-approver-authorization'] };
    const result = operation === 'status'
      ? { status: await options.bridge.status(input, controller.signal) }
      : await options.bridge.resume(input, controller.signal);
    send(200, result);
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) { if (!res.destroyed) res.destroy(); }
    else {
      const cause = error as { status?: number; code?: string };
      const status = cause.status ?? (cause.code === 'SOP_RESUME_REQUEST_CONFLICT' ? 409 : 502);
      send(status, { code: cause.code ?? 'PUBLIC_APPROVAL_BRIDGE_FAILED' });
    }
  } finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
  return true;
}
