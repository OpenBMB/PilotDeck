import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const mod = { exports: {} };
new Function('module','exports','require',ts.transpileModule(fs.readFileSync(new URL('../src/runtimeLogExport.ts',import.meta.url),'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)(mod,mod.exports,require);

test('log export includes retained history and reports, redacts secrets and supports Chinese destinations', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-export-'));
  try {
    const logs = path.join(directory,'logs'); fs.mkdirSync(logs); fs.mkdirSync(path.join(logs,'diagnostics'));
    fs.writeFileSync(path.join(logs,'runtime.log'), 'PD_RUNTIME_OUT_OF_MEMORY\nAuthorization: Bearer abcdef-secret\n');
    fs.writeFileSync(path.join(logs,'runtime-2026-11-01-1234abcd.log'), 'older log\n');
    fs.writeFileSync(path.join(logs,'renderer.log'), 'renderer event\n');
    fs.writeFileSync(path.join(logs,'diagnostics/gateway-1234abcd.json'), '{"event":"Allocation failed"}\n');
    fs.writeFileSync(path.join(logs,'unrelated.json'), 'not included');
    const destination = path.join(directory,'运行日志.log');
    await mod.exports.exportRuntimeLogs(path.join(logs,'runtime.log'), destination);
    const result = fs.readFileSync(destination,'utf8');
    for (const evidence of ['PD_RUNTIME_OUT_OF_MEMORY','older log','renderer event','Allocation failed']) assert.ok(result.includes(evidence));
    assert.doesNotMatch(result,/abcdef-secret|not included/);
    await assert.rejects(mod.exports.exportRuntimeLogs(path.join(logs,'runtime.log'), path.join(logs,'runtime.log')), /outside/);
    await assert.rejects(mod.exports.exportRuntimeLogs(path.join(logs,'runtime.log'), path.join(directory,'missing/file.log')));
    assert.equal(fs.readdirSync(directory).some(file => file.endsWith('.tmp')),false);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
