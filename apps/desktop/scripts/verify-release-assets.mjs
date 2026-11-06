#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describeReleaseAsset, compatibilityFeeds } from '../../../ui/shared/releaseArtifacts.js';

export function verifyReleaseAssets(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
  const prefix = `PilotDeck-${manifest.version}`;
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const expected = [
    ...['x64', 'arm64'].flatMap(arch => [
      [`${prefix}-linux-${arch}.deb`, `latest-linux${arch === 'arm64' ? '-arm64' : ''}.yml`, 'linux', arch],
      [`${prefix}-linux-${arch}.rpm`, `latest-rpm-linux${arch === 'arm64' ? '-arm64' : ''}.yml`, 'linux', arch],
      [`${prefix}-mac-${arch}.zip`, `latest-${arch}-mac.yml`, 'darwin', arch],
      [`${prefix}-win-${arch}-setup.exe`, `latest-${arch}.yml`, 'win32', arch],
    ]),
  ];
  const payloadNames = [...expected.map(([name]) => name), ...['x64', 'arm64'].map(arch => `${prefix}-mac-${arch}.dmg`)];
  const requiredNames = [...payloadNames, ...expected.map(([, feed]) => feed)];
  // Old immutable releases remain verifiable for OBS repair. New manifests
  // require maps even when the release's emergency switch disables their use.
  if (manifest.differentialUpdates !== undefined) {
    assert.equal(typeof manifest.differentialUpdates, 'boolean', 'Invalid differential capability');
    for (const name of payloadNames.filter(name => /\.(exe|zip)$/.test(name))) {
      requiredNames.push(`${name}.blockmap`);
      const bytes = readFileSync(join(directory, `${name}.blockmap`));
      assert.ok(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, `Invalid blockmap size: ${name}`);
      const map = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString());
      assert.equal(map.version, '2', `Unsupported blockmap: ${name}`);
      assert.equal(map.files?.length, 1, `Invalid blockmap files: ${name}`);
      const file = map.files[0];
      assert.equal(file.offset, 0, `Invalid blockmap offset: ${name}`);
      assert.ok(file.checksums?.length > 0 && file.checksums.length === file.sizes?.length, `Invalid blockmap blocks: ${name}`);
      assert.ok(file.sizes.every(n => Number.isSafeInteger(n) && n > 0), `Invalid block sizes: ${name}`);
      assert.ok(file.checksums.every(hash => typeof hash === 'string' && hash.length > 0), `Invalid block hashes: ${name}`);
      assert.equal(file.sizes.reduce((a, b) => a + b, 0), statSync(join(directory, name)).size, `Blockmap payload size differs: ${name}`);
    }
  }
  const checksums = readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8');
  assert.equal(new Set(manifest.assets.map(a => a.name)).size, manifest.assets.length, 'Duplicate manifest asset');
  for (const asset of manifest.assets) {
    assert.match(asset.name, /^[\w-][\w.-]*$/);
    const bytes = readFileSync(join(directory, asset.name));
    assert.equal(bytes.length, asset.size, `Incorrect size: ${asset.name}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `Incorrect SHA256: ${asset.name}`);
    assert.equal(createHash('sha512').update(bytes).digest('base64'), asset.sha512, `Incorrect SHA512: ${asset.name}`);
    if (manifest.artifactSchemaVersion === 1) {
      const expected = describeReleaseAsset(asset.name);
      for (const key of ['platform', 'arch', 'format', 'roles']) assert.deepEqual(asset[key], expected[key], `Incorrect ${key}: ${asset.name}`);
    }
  }
  assert.deepEqual(readdirSync(directory).sort(), [...manifest.assets.map(a => a.name), 'release.json', 'SHA256SUMS.txt'].sort(), 'Unexpected release files');
  if (manifest.artifactSchemaVersion === 1) {
    for (const feed of compatibilityFeeds(manifest)) {
      assert.equal(readFileSync(join(directory, feed.name), 'utf8'), feed.text, `Compatibility feed differs from JSON: ${feed.name}`);
    }
  }
  for (const name of requiredNames) {
    const asset = manifest.assets.find(asset => asset.name === name);
    assert.ok(asset && asset.size > 0, `Missing release asset: ${name}`);
    assert.equal(statSync(join(directory, name)).size, asset.size, `Incorrect size: ${name}`);
    assert.ok(checksums.split('\n').includes(`${asset.sha256}  ${name}`), `Missing checksum: ${name}`);
  }
  // Reject stale installers as well as missing ones: publishing another version
  // beside the current packages would make the architecture choice ambiguous.
  const installers = readdirSync(directory).filter(name => /\.(deb|rpm|dmg|zip|exe)$/.test(name));
  assert.deepEqual(installers.sort(), payloadNames.sort(), 'Unexpected installer names or versions');
  for (const [name, feedName, platform, arch] of expected) {
    const asset = manifest.assets.find(asset => asset.name === name);
    assert.equal(asset.platform, platform, name);
    assert.equal(asset.arch, arch, name);
    const feed = readFileSync(join(directory, feedName), 'utf8').replaceAll('\r\n', '\n');
    const escapedVersion = manifest.version.replaceAll('.', '\\.');
    assert.match(feed, new RegExp(`^version: ${escapedVersion}$`, 'm'), `Wrong feed version: ${feedName}`);
    // Electron-builder emits these three fields in this order. Validate every
    // file entry, including a macOS DMG when its feed also lists the disk image.
    const entries = [...feed.matchAll(/^  - url: (\S+)\n    sha512: (\S+)\n    size: (\d+)$/gm)];
    assert.ok(entries.length > 0 && entries.length === (feed.match(/^  - url:/gm) || []).length, `Invalid feed: ${feedName}`);
    assert.ok(entries.some(([, url]) => url === name), `Missing payload in feed: ${feedName}`);
    for (const [, url, sha512, size] of entries) {
      const referenced = manifest.assets.find(asset => asset.name === url);
      assert.ok(referenced && payloadNames.includes(url), `Unknown feed payload: ${url}`);
      assert.equal(referenced.platform, platform, `Wrong feed platform: ${url}`);
      assert.equal(referenced.arch, arch, `Wrong feed architecture: ${url}`);
      assert.equal(sha512, referenced.sha512, `Wrong feed checksum: ${url}`);
      assert.equal(Number(size), referenced.size, `Wrong feed size: ${url}`);
      if (platform === 'linux') assert.equal(url, name, `Wrong Linux package type: ${url}`);
    }
  }
  return { installers: payloadNames.length, feeds: expected.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyReleaseAssets(resolve(process.argv[2] || 'release-assets'));
  console.log(`Verified ${result.installers} installers and ${result.feeds} architecture-specific update feeds`);
}
