// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { compareVersions, getLatestRelease, normalizeRepository, releaseVersion } from './releaseService.js';

const release = (tag, extras = {}) => ({ tag_name: tag, assets: [{ name: 'release.json' }], ...extras });
const manifest = { schemaVersion: 1, tag: 'v2026.09.07-r10', sourceSha: 'a'.repeat(40), repository: 'OpenBMB/PilotDeck', version: '2026.907.9', assets: [] };
const response = (data) => ({ ok: true, json: async () => data });
describe('unified release discovery', () => {
  it('selects the latest stable dated release and validates its source manifest', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([
      release('desktop-v2026.09.08'), release('v2026.09.07-r2'), release('v2026.09.07'),
      release('v2026.09.07-r10'), release('v2026.09.09', { prerelease: true }), release('v2026.09.10', { draft: true }),
    ])).mockResolvedValueOnce(response(manifest));
    expect(await getLatestRelease({ fetchImpl, env: {} })).toMatchObject({ tagName: manifest.tag, sourceSha: manifest.sourceSha });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://github.com/OpenBMB/PilotDeck/releases/download/v2026.09.07-r10/release.json');
  });
  it.each([{ ...manifest, tag: 'wrong' }, { ...manifest, sourceSha: 'main' }, { ...manifest, repository: 'fork/PilotDeck' }])('rejects invalid source metadata', async (data) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([release(manifest.tag)])).mockResolvedValueOnce(response(data));
    await expect(getLatestRelease({ fetchImpl, env: {} })).rejects.toThrow('does not match');
  });
  it('fails closed without unified releases or a complete manifest', async () => {
    await expect(getLatestRelease({ fetchImpl: async () => response([release('desktop-v2026.09.07')]) })).rejects.toThrow('No unified');
    await expect(getLatestRelease({ fetchImpl: async () => response([release('v2026.09.07', { assets: [] })]) })).rejects.toThrow('no release.json');
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
  const asset = { name: 'PilotDeck-mac-arm64.dmg', platform: 'darwin', arch: 'arm64', size: 42, sha256: 'a'.repeat(64) };
  async function discover(data, published = asset) {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([release(manifest.tag, { assets: [{ name: 'release.json' }, published] })]))
      .mockResolvedValueOnce(response(data));
    return getLatestRelease({ fetchImpl, env: {} });
  }
  it('uses the verified manifest and canonical download URL', async () => {
    const result = await discover({ ...manifest, assets: [asset] }, { ...asset, browser_download_url: 'https://untrusted.invalid/file' });
    expect(result.assets[0].downloadUrl).toBe(`https://github.com/OpenBMB/PilotDeck/releases/download/${manifest.tag}/${asset.name}`);
  });
  it.each([
    { ...manifest, version: '2026.907.1' },
    { ...manifest, assets: [{ ...asset, name: '../installer.dmg' }] },
    { ...manifest, assets: [{ ...asset, sha256: '' }] },
    { ...manifest, assets: [{ ...asset, size: 0 }] },
    { ...manifest, assets: [asset, asset] },
  ])('rejects inconsistent or unsafe metadata', async (data) => {
    await expect(discover(data)).rejects.toThrow();
  });
  it('rejects an unpublished or wrong-size installer', async () => {
    await expect(discover({ ...manifest, assets: [asset] }, { ...asset, size: 43 })).rejects.toThrow();
    await expect(discover({ ...manifest, assets: [asset] }, { name: 'other.dmg' })).rejects.toThrow();
  });
});
