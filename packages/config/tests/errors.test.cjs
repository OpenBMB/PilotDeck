const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyRuntimeError, registerDiagnosticSecrets, redactDiagnostic } = require('../index.cjs');
test('classifies evidence and OS errors with a stable unknown fallback', () => {
  for (const [error, evidence, status, expected] of [
    [{ code: 'EADDRINUSE' }, '', undefined, 'PD_NETWORK_PORT_IN_USE'],
    [new Error('fetch failed', { cause: { code: 'ENOTFOUND' } }), '', undefined, 'PD_NETWORK_UNAVAILABLE'],
    [{ name: 'PilotConfigError', code: 'CONFIG_AGENT_MODEL_INVALID' }, '', undefined, 'PD_CONFIG_INVALID'],
    [{ code: 'ENOENT' }, '', undefined, 'PD_RESOURCE_NOT_FOUND'],
    [{ code: 'EACCES' }, '', undefined, 'PD_FILESYSTEM_PERMISSION'],
    [{ code: 'ENOSPC' }, '', undefined, 'PD_FILESYSTEM_FULL'],
    [new Error('Timed out waiting for port'), '', undefined, 'PD_RUNTIME_TIMEOUT'],
    [new Error('exited code=134 signal=null'), '', undefined, 'PD_RUNTIME_PROCESS_FAILED'],
    [null, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', undefined, 'PD_RUNTIME_OUT_OF_MEMORY'],
    [null, 'Assertion failed: invalid pointer', undefined, 'PD_RUNTIME_NATIVE_FAILURE'],
    [{}, '', 401, 'PD_AUTH_REJECTED'], [{}, '', 429, 'PD_RATE_LIMITED'],
    [null, '', undefined, 'PD_UNEXPECTED_ERROR'],
  ]) assert.equal(classifyRuntimeError(error, evidence, status), expected);
});
test('redacts registered secrets, authorization and key-shaped fields without logging values', () => {
  registerDiagnosticSecrets({ apiKey: 'multiline\nvalue-123', privateKey: 'opaque-secret' });
  const safe = redactDiagnostic('multiline\nvalue-123 opaque-secret Authorization: Bearer abcdef token=another-secret https://user:password@example.test');
  for (const secret of ['value-123', 'opaque-secret', 'abcdef', 'another-secret', 'user:password']) assert.ok(!safe.includes(secret));
  assert.ok(!redactDiagnostic('https://example.test/api?key=api-query-secret&token=another-query-secret').includes('query-secret'));
});
