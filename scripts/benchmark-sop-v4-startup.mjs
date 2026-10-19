import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const root = resolve(process.argv[2]);
const report = { scenario: 'prepared local processes; not OS cold cache', limitMs: 10000, rounds: [] };
async function control(action) {
  const began = performance.now();
  const child = spawn(process.execPath, ['scripts/sop-v4-source.mjs', action, root], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  assert.equal(code, 0, `${action} failed`);
  return performance.now() - began;
}
try {
  for (let round = 1; round <= 10; round++) {
    const commandElapsedMs = await control('start');
    const timing = JSON.parse(await readFile(join(root, 'start-timing.json'), 'utf8'));
    report.rounds.push({ round, ...timing, commandElapsedMs });
    await control('stop');
  }
  const values = report.rounds.map(row => row.commandElapsedMs).sort((a, b) => a - b);
  report.maximumMs = values.at(-1); report.medianMs = (values[4] + values[5]) / 2;
  report.passed = values.length === 10 && values.every(value => value <= report.limitMs);
} finally {
  await writeFile(join(root, 'startup-benchmark.json'), JSON.stringify(report, null, 2));
}
assert.equal(report.passed, true, 'Startup exceeds 10 seconds');
console.log(JSON.stringify(report));
