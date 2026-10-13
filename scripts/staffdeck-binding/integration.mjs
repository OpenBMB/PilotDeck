import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const scripts = dirname(fileURLToPath(import.meta.url)), pd = resolve(scripts, '../..');
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
const results = [], env = { ...process.env }; delete env.NODE_OPTIONS;
for (const [file, isPython] of [['runtime.mjs', false], ['sync.mjs', false], ['sop-lifecycle.mjs', false],
  ['compatibility.mjs', false], ['upgrade.py', true]]) {
  const started = Date.now();
  const value = spawnSync(isPython ? process.env.BINDING_QA_PYTHON : process.execPath, [join(scripts, file)], {
    cwd: pd, env, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(qa, `${file}-private.log`), (value.stdout || '') + (value.stderr || ''), { mode: 0o600 });
  results.push({ file, status: value.status === 0 ? 'PASS' : 'FAIL', elapsedMs: Date.now() - started,
    exitCode: value.status, ...(value.error ? { error: value.error.message } : {}) });
  writeFileSync(join(qa, 'integration-result.json'), JSON.stringify(results, null, 2));
  console.log(results.at(-1).status, file, results.at(-1).elapsedMs);
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
