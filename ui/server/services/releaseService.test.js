// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { compareVersions, getLatestRelease, normalizeRepository, releaseVersion } from './releaseService.js';

const asset = { name: 'PilotDeck-2026.907.9-mac-arm64.zip', platform: 'darwin', arch: 'arm64', size: 42,
  sha256: 'a'.repeat(64), sha512: 'A'.repeat(86) + '==' };
const manifest = { schemaVersion: 1, tag: 'v2026.09.07-r10', sourceSha: 'a'.repeat(40),
  repository: 'OpenBMB/PilotDeck', version: '2026.907.9', assets: [asset] };
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const discover = (data = manifest) => getLatestRelease({ fetchImpl: async () => response(data) });

describe('unified release discovery', () => {
  it('reads the Latest release manifest without calling the rate-limited REST API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(manifest));
    const latest = await getLatestRelease({ fetchImpl, env: { GITHUB_TOKEN: 'unused-public-asset-token' } });
    expect(latest).toMatchObject({ tagName: manifest.tag, version: manifest.version, sourceSha: manifest.sourceSha });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://github.com/OpenBMB/PilotDeck/releases/latest/download/release.json');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it.each([
    { ...manifest, tag: 'desktop-v2026.09.07' },
    { ...manifest, tag: 'v2026.02.30' },
    { ...manifest, sourceSha: 'main' },
    { ...manifest, repository: 'fork/PilotDeck' },
    { ...manifest, version: '2026.907.1' },
    { ...manifest, assets: [] },
  ])('rejects inconsistent release metadata', async (data) => {
    await expect(discover(data)).rejects.toThrow('does not match');
  });
  it('fails clearly when the Latest release has no manifest', async () => {
    await expect(getLatestRelease({ fetchImpl: async () => response({}, 404) })).rejects.toThrow('(404)');
  });
});

describe('release versions and installer manifest validation', () => {
  it.each([['v2026.01.09', '2026.109.0'], ['v2026.09.07-r10', '2026.907.9']])('maps %s to the build version', (tag, version) => {
    expect(releaseVersion(tag)).toBe(version);
  });
  it('compares numeric components, including revisions and year boundaries', () => {
    expect(compareVersions('2026.109.0', '2026.110.0')).toBe(-1);
    expect(compareVersions('2026.907.9', '2026.907.10')).toBe(-1);
    expect(compareVersions('2026.1231.0', '2027.101.0')).toBe(-1);
    expect(compareVersions('2026.907.10', '2026.907.9')).toBe(1);
    expect(compareVersions('2026.907.0', '2026.907.0')).toBe(0);
  });
  it.each(['v2026.02.30', 'v2026.13.01', 'desktop-v2026.09.07', 'v2026.09.07-r0'])('rejects invalid tags %s', (tag) => {
    expect(() => releaseVersion(tag)).toThrow();
  });
  it('normalizes repository URLs without falling back to a different repository', () => {
    expect(normalizeRepository()).toBe('OpenBMB/PilotDeck');
    expect(normalizeRepository('https://github.com/example/PilotDeck.git')).toBe('example/PilotDeck');
    expect(() => normalizeRepository('../PilotDeck')).toThrow();
  });
  it('pins downloads to the validated manifest tag', async () => {
    const latest = await discover();
    expect(latest.assets[0].downloadUrl).toBe(`https://github.com/OpenBMB/PilotDeck/releases/download/${manifest.tag}/${asset.name}`);
  });
  it.each([
    { ...asset, name: '../installer.zip' },
    { ...asset, sha256: '' },
    { ...asset, sha512: '' },
    { ...asset, size: 0 },
  ])('rejects unsafe or incomplete assets', async (badAsset) => {
    await expect(discover({ ...manifest, assets: [badAsset] })).rejects.toThrow('Invalid installer manifest');
  });
  it('rejects duplicate asset names', async () => {
    await expect(discover({ ...manifest, assets: [asset, asset] })).rejects.toThrow('Invalid installer manifest');
  });
});
