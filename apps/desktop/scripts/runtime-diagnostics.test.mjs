import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { spawnManaged, stopProcessTree } from '../../../ui/server/utils/processTree.js';
import { waitForManagedEvent } from './process-test-helpers.mjs';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/runtimeDiagnostics.ts', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'require', ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText)(mod, mod.exports, require);
const { RuntimeProcessDiagnostics, runtimeReportArguments, runtimeReportDirectory } = mod.exports;

test('exit 134 without evidence remains an unknown process failure', () => {
  const diagnostics = new RuntimeProcessDiagnostics('gateway', '/logs/runtime.log');
  const detail = diagnostics.exited(134, null);
  assert.match(detail, /GATEWAY_PROCESS_FAILED.*phase=startup/);
  assert.match(detail, /code=134 signal=null/);
  assert.match(detail, /Runtime log:/);
  assert.doesNotMatch(detail, /OUT_OF_MEMORY/);
});

test('split UTF-8 and fatal output survives a long native stack and is bounded', () => {
  const diagnostics = new RuntimeProcessDiagnostics('gateway', '/logs/runtime.log');
  const message = Buffer.from('中文\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n');
  diagnostics.captureStderr(message.subarray(0, 1));
  diagnostics.captureStderr(message.subarray(1, 60));
  diagnostics.captureStderr(message.subarray(60));
  diagnostics.captureStderr(Buffer.from(' native frame\n'.repeat(3000)));
  const detail = diagnostics.exited(134, null);
  assert.match(detail, /GATEWAY_OUT_OF_MEMORY/);
  assert.match(detail, /FATAL ERROR: Reached heap limit/);
  assert.ok(detail.length < 6_000);
  assert.doesNotMatch(detail, /\uFFFD/);
});

test('running native assertions retain phase, exit details and redact credentials', () => {
  const diagnostics = new RuntimeProcessDiagnostics('gateway', '/logs/runtime.log');
  diagnostics.markReady();
  diagnostics.captureStderr(Buffer.from('Assertion failed: worker_thread\nAuthorization: Bearer test-secret\napiKey="api-secret"\nhttps://user:password@example.test\n'));
  const detail = diagnostics.exited(134, null, 'startup context');
  assert.match(detail, /GATEWAY_NATIVE_FAILURE.*phase=running/);
  assert.match(detail, /code=134 signal=null/);
  assert.match(detail, /startup context/);
  assert.doesNotMatch(detail, /test-secret|api-secret|user:password/);
});

test('a fatal line at the start of one oversized stderr chunk is not discarded', () => {
  const diagnostics = new RuntimeProcessDiagnostics('gateway', '/logs/runtime.log');
  diagnostics.captureStderr(Buffer.from('FATAL ERROR: Allocation failed - process out of memory\n' + ' native frame\n'.repeat(3000)));
  assert.match(diagnostics.exited(134, null), /GATEWAY_OUT_OF_MEMORY/);
});

test('fragmented compact reports are kept out of the error excerpt and save failures are nonfatal', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-runtime-diagnostics-'));
  const logPath = path.join(directory, 'runtime.log');
  // A blocked destination must not turn an optional report into another crash.
  fs.writeFileSync(runtimeReportDirectory(logPath), 'not a directory');
  const diagnostics = new RuntimeProcessDiagnostics('gateway', logPath);
  const line = Buffer.from(JSON.stringify({ header: { nodejsVersion: process.version }, javascriptHeap: { totalMemory: 42 } }) + '\n');
  try {
    diagnostics.captureStderr(line.subarray(0, 8));
    diagnostics.captureStderr(line.subarray(8));
    const detail = diagnostics.exited(134, null);
    assert.match(detail, /Could not save separate fatal report/);
    assert.match(detail, /Runtime log:/);
    assert.doesNotMatch(detail, /totalMemory/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pilotdeck-runtime-diagnostics-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a real supervised OOM produces a diagnostic report without environment variables', { timeout: 120_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-runtime-diagnostics-'));
  const logPath = path.join(directory, '日志 with spaces', 'runtime.log');
  const reportDirectory = runtimeReportDirectory(logPath);
  fs.mkdirSync(reportDirectory, { recursive: true });
  const diagnostics = new RuntimeProcessDiagnostics('gateway', logPath);
  const child = spawnManaged(process.execPath, [
    ...runtimeReportArguments(), '--max-old-space-size=16', '-e',
    'const retained=[];while(true)retained.push(new Array(65536).fill(42));',
  ], { env: { ...process.env, NODE_OPTIONS: '', PILOTDECK_DIAGNOSTIC_TEST_SECRET: 'not-in-report' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.on('data', chunk => diagnostics.captureStderr(chunk));
  try {
    const [code, signal] = await waitForManagedEvent(child, child, 'managed-exit');
    if (process.platform === 'win32') assert.equal(code, 134);
    assert.match(diagnostics.exited(code, signal), /GATEWAY_OUT_OF_MEMORY/);
    const reports = fs.readdirSync(reportDirectory).filter(file => file.endsWith('.json'));
    assert.equal(reports.length, 1);
    const report = JSON.parse(fs.readFileSync(path.join(reportDirectory, reports[0]), 'utf8'));
    assert.match(report.header.event, /heap out of memory/);
    assert.ok(report.javascriptHeap);
    assert.ok(report.nativeStack);
    assert.equal(report.environmentVariables, undefined);
  } finally {
    await stopProcessTree(child, { forceMs: 10_000 });
    child.stdout.destroy();
    child.stderr.destroy();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pilotdeck-runtime-diagnostics-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
