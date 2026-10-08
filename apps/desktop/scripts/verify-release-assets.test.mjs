import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyReleaseAssets } from './verify-release-assets.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pilotdeck-complete-release-'));
  const prefix = 'PilotDeck-2026.1004.0';
  const assets = [];
  const feeds = [];
  function add(name, contents, platform, arch) {
    const bytes = Buffer.from(contents);
    writeFileSync(join(directory, name), bytes);
    const asset = { name, platform, arch, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64') };
    assets.push(asset);
    return asset;
  }
  for (const arch of ['x64', 'arm64']) {
    for (const [suffix, feed, platform] of [
      [`linux-${arch}.deb`, `latest-linux${arch === 'arm64' ? '-arm64' : ''}.yml`, 'linux'],
      [`linux-${arch}.rpm`, `latest-rpm-linux${arch === 'arm64' ? '-arm64' : ''}.yml`, 'linux'],
      [`mac-${arch}.zip`, `latest-${arch}-mac.yml`, 'darwin'],
      [`win-${arch}-setup.exe`, `latest-${arch}.yml`, 'win32'],
    ]) {
      const payloads = [add(`${prefix}-${suffix}`, suffix, platform, arch)];
      if (platform === 'darwin') payloads.push(add(`${prefix}-mac-${arch}.dmg`, 'disk image', platform, arch));
      feeds.push({ name: feed, contents: `version: 2026.1004.0\nfiles:\n${payloads.map(asset => `  - url: ${asset.name}\n    sha512: ${asset.sha512}\n    size: ${asset.size}\n`).join('')}`, platform, arch });
    }
  }
  for (const feed of feeds) add(feed.name, feed.contents, feed.platform, feed.arch);
  writeFileSync(join(directory, 'release.json'), JSON.stringify({ version: '2026.1004.0', assets }));
  writeFileSync(join(directory, 'SHA256SUMS.txt'), assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''));
  return { directory, prefix, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function replaceFeed(directory, name, contents) {
  writeFileSync(join(directory, name), contents);
  // The release manifest is generated after feeds are downloaded. Update its
  // checksums as well so these cases exercise metadata validation, rather than
  // merely detecting a file edited after manifest generation.
  const manifestPath = join(directory, 'release.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const asset = manifest.assets.find(asset => asset.name === name);
  const bytes = Buffer.from(contents);
  Object.assign(asset, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64') });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(directory, 'SHA256SUMS.txt'), manifest.assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''));
}

test('accepts all 10 installers and 8 feeds without changing existing filenames', () => {
  const f = fixture();
  try { assert.deepEqual(verifyReleaseAssets(f.directory), { installers: 10, feeds: 8 }); }
  finally { f.cleanup(); }
});

for (const name of ['PilotDeck-2026.1004.0-win-arm64-setup.exe', 'PilotDeck-2026.1004.0-linux-arm64.rpm', 'PilotDeck-2026.1004.0-linux-x64.rpm', 'latest-arm64.yml']) {
  test(`refuses publication when ${name} is absent`, () => {
    const f = fixture();
    try {
      rmSync(join(f.directory, name));
      assert.throws(() => verifyReleaseAssets(f.directory));
    } finally { f.cleanup(); }
  });
}

for (const [description, transform] of [
  ['wrong architecture', feed => feed.replaceAll('win-arm64', 'win-x64')],
  ['wrong version', feed => feed.replace('version: 2026.1004.0', 'version: 2026.1003.0')],
  ['wrong checksum', feed => feed.replace(/sha512: \S+/, `sha512: ${'A'.repeat(86)}==`)],
  ['wrong size', feed => feed.replace(/size: \d+/, 'size: 1')],
  ['unknown payload', feed => feed.replaceAll('PilotDeck-', 'Unknown-')],
]) {
  test(`refuses a Windows ARM64 feed with ${description}`, () => {
    const f = fixture();
    try {
      const file = join(f.directory, 'latest-arm64.yml');
      replaceFeed(f.directory, 'latest-arm64.yml', transform(readFileSync(file, 'utf8')));
      assert.throws(() => verifyReleaseAssets(f.directory));
    } finally { f.cleanup(); }
  });
}

test('refuses a stale installer even when the current packages are present', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, 'PilotDeck-2026.1003.0-win-x64-setup.exe'), 'stale');
    assert.throws(() => verifyReleaseAssets(f.directory), /Unexpected installer/);
  } finally { f.cleanup(); }
});
