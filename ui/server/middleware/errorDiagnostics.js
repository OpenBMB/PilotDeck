import { randomUUID } from 'node:crypto';
import { classifyRuntimeError, redactDiagnostic } from '@pilotdeck/config';

export function createErrorDiagnostics(logPath) {
  return (req, res, next) => {
    const diagnosticId = randomUUID(), json = res.json;
    res.json = function(body) {
      if (body && typeof body === 'object' && !Array.isArray(body) && (res.statusCode >= 400 || body.error || body.success === false || body.ok === false)) {
        const diagnosticCode = classifyRuntimeError({ code: body.code, message: body.error || body.message }, '', res.statusCode);
        body = { ...body, code: body.code || diagnosticCode, diagnosticCode, diagnosticId, logPath };
        console.warn(`[${diagnosticCode}] diagnostic=${diagnosticId} ${req.method} ${req.path} status=${res.statusCode}`);
      }
      return json.call(this, body);
    };
    next();
  };
}
export function handleUnexpectedError(error, req, res, next) {
  const code = classifyRuntimeError(error, '', error.status || 500);
  console.error(`[${code}] ${redactDiagnostic(error.stack || error.message || error)}`);
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ error: error.status && error.status < 500 ? error.message : 'The operation failed. See the runtime log.', code });
}
