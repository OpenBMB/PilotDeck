const secrets = new Set();
const sensitive = /api.?key|token|password|secret|authorization|credential.value|private.?key/i;
function registerDiagnosticSecrets(value, key = '', depth = 0) {
  if (depth > 20) return;
  if (typeof value === 'string' && sensitive.test(key) && value.length >= 4) secrets.add(value);
  else if (value && typeof value === 'object') for (const [field, item] of Object.entries(value)) registerDiagnosticSecrets(item, field, depth + 1);
  while (secrets.size > 4096) secrets.delete(secrets.values().next().value);
}
function redactDiagnostic(value) {
  let text = String(value);
  for (const secret of secrets) if (text.includes(secret)) text = text.split(secret).join('[redacted]');
  return text.replace(/((?:Bearer|Basic)\s+)[\w.+/~=-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'\r\n]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
}
function classifyRuntimeError(error, evidence = '', status) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^PD_[A-Z0-9_]+$/.test(code)) return code;
  const text = `${error?.message || error || ''}\n${evidence}`;
  if (/FATAL ERROR:[^\r\n]*(?:heap out of memory|process out of memory)/i.test(text)) return 'PD_RUNTIME_OUT_OF_MEMORY';
  if (/Assertion failed:|Check failed:|# Fatal error in /i.test(text)) return 'PD_RUNTIME_NATIVE_FAILURE';
  if (code === 'EADDRINUSE' || /EADDRINUSE/.test(text)) return 'PD_NETWORK_PORT_IN_USE';
  if (['EACCES', 'EPERM'].includes(code) || /\b(EACCES|EPERM)\b/.test(text)) return 'PD_FILESYSTEM_PERMISSION';
  if (['ENOENT', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(code) || /\bENOENT\b/.test(text)) return 'PD_RESOURCE_NOT_FOUND';
  if (code === 'ERR_DLOPEN_FAILED') return 'PD_RUNTIME_NATIVE_FAILURE';
  if (code === 'ENOSPC' || /\bENOSPC\b/.test(text)) return 'PD_FILESYSTEM_FULL';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || /timed? ?out|timeout|deadline exceeded/i.test(text)) return 'PD_RUNTIME_TIMEOUT';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(code)) return 'PD_NETWORK_UNAVAILABLE';
  if (error?.name === 'AbortError' || code === 'ABORT_ERR') return 'PD_OPERATION_CANCELLED';
  if (status === 401 || status === 403) return 'PD_AUTH_REJECTED';
  if (status === 404) return 'PD_RESOURCE_NOT_FOUND';
  if (status === 409) return 'PD_OPERATION_CONFLICT';
  if (status === 429) return 'PD_RATE_LIMITED';
  if (status >= 400 && status < 500) return 'PD_REQUEST_INVALID';
  if (/exited|process.*failed|spawn/i.test(text)) return 'PD_RUNTIME_PROCESS_FAILED';
  return 'PD_UNEXPECTED_ERROR';
}
module.exports = { registerDiagnosticSecrets, redactDiagnostic, classifyRuntimeError };
