import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sd = process.env.STAFFDECK_CHECKOUT || resolve(pd, '../StaffDeck');
const destination = process.argv[2]; assert.ok(destination);
function git(cwd, ...args) {
  const value = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(value.status, 0, value.stderr); return value.stdout.trim();
}
const candidates = [pd, sd].map(path => ({ path, branch: git(path, 'branch', '--show-current'),
  commit: git(path, 'rev-parse', 'HEAD'),
  dirty: git(path, 'status', '--short').split('\n').filter(line => !/^\?\? (?:ui\/)?node_modules$/.test(line)),
  trackedDiff: git(path, 'diff', '--stat') }));
writeFileSync(destination, JSON.stringify({ recordedAt: new Date().toISOString(), candidates,
  status: 'Uncommitted review candidate; builds and focused rechecks performed after defect fixes',
  dependencyLinksExcluded: ['node_modules', 'ui/node_modules'] }, null, 2) + '\n');
console.log('Recorded candidate branches, commits and dirty paths');
