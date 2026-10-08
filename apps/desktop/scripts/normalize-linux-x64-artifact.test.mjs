import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeLinuxX64Artifact } from './normalize-linux-x64-artifact.mjs';

test('Linux x64 package and updater feed publish the same x64 filename', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pilotdeck-linux-'));
  const oldName = 'PilotDeck-2026.929.0-linux-amd64.deb';
  const newName = 'PilotDeck-2026.929.0-linux-x64.deb';
  try {
    writeFileSync(join(directory, oldName), 'package');
    writeFileSync(join(directory, 'latest-linux.yml'), `path: ${oldName}\nfiles:\n  - url: ${oldName}\n`);
    assert.equal(normalizeLinuxX64Artifact(directory), newName);
    assert.equal(existsSync(join(directory, oldName)), false);
    assert.equal(readFileSync(join(directory, newName), 'utf8'), 'package');
    assert.equal(readFileSync(join(directory, 'latest-linux.yml'), 'utf8'), `path: ${newName}\nfiles:\n  - url: ${newName}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
