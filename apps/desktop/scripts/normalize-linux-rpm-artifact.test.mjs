import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeLinuxRpmArtifact } from './normalize-linux-rpm-artifact.mjs';

for (const [arch, rpmArch] of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
  test(`normalizes ${rpmArch} RPM and its matching feed without changing package contents`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-rpm-'));
    try {
      const oldName = `PilotDeck-2026.1004.0-linux-${rpmArch}.rpm`;
      const newName = `PilotDeck-2026.1004.0-linux-${arch}.rpm`;
      const feed = join(dir, `latest-rpm-linux${arch === 'arm64' ? '-arm64' : ''}.yml`);
      writeFileSync(join(dir, oldName), 'RPM contents');
      writeFileSync(feed, `files:\n  - url: ${oldName}\n    sha512: unchanged\npath: ${oldName}\n`);
      assert.equal(normalizeLinuxRpmArtifact(dir, arch), newName);
      assert.equal(readFileSync(join(dir, newName), 'utf8'), 'RPM contents');
      assert.equal(readFileSync(feed, 'utf8'), `files:\n  - url: ${newName}\n    sha512: unchanged\npath: ${newName}\n`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('refuses ambiguous RPMs and a feed that does not reference the payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-rpm-'));
  try {
    assert.throws(() => normalizeLinuxRpmArtifact(dir, 'x64'), /found 0/);
    assert.throws(() => normalizeLinuxRpmArtifact(dir, 'ia32'), /Unsupported/);
    writeFileSync(join(dir, 'PilotDeck-linux-x86_64.rpm'), 'one');
    writeFileSync(join(dir, 'latest-rpm-linux.yml'), 'other.rpm');
    assert.throws(() => normalizeLinuxRpmArtifact(dir, 'x64'), /does not reference/);
    writeFileSync(join(dir, 'Other-linux-x86_64.rpm'), 'two');
    assert.throws(() => normalizeLinuxRpmArtifact(dir, 'x64'), /found 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
