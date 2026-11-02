const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyRuntimeError, registerDiagnosticSecrets, redactDiagnostic } = require('../index.cjs');
const { spawnSync } = require('node:child_process');
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

test('classification keeps same-line ordering and mixed-case native evidence', () => {
  assert.equal(classifyRuntimeError(null, 'fatal error: PROCESS OUT OF MEMORY'), 'PD_RUNTIME_OUT_OF_MEMORY');
  assert.equal(classifyRuntimeError(null, 'heap out of memory\nFATAL ERROR:'), 'PD_UNEXPECTED_ERROR');
  assert.equal(classifyRuntimeError(null, 'FATAL ERROR:\nheap out of memory'), 'PD_UNEXPECTED_ERROR');
  assert.equal(classifyRuntimeError(null, 'PROCESS initialization FAILED'), 'PD_RUNTIME_PROCESS_FAILED');
  assert.equal(classifyRuntimeError(null, 'failed\nprocess'), 'PD_UNEXPECTED_ERROR');
  assert.equal(classifyRuntimeError(null, 'process\nfailed'), 'PD_UNEXPECTED_ERROR');
});

test('repeated fatal/process markers cannot monopolize the diagnostics thread', () => {
  const script = `const assert=require('node:assert/strict');
    const {classifyRuntimeError}=require(${JSON.stringify(require.resolve('../index.cjs'))});
    for(const marker of ['FATAL ERROR:', 'process']) {
      assert.equal(classifyRuntimeError(null, marker.repeat(30000)), 'PD_UNEXPECTED_ERROR');
    }`;
  const result = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
