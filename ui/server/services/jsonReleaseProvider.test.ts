// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { JsonReleaseProvider, releaseTagForVersion } from '../../../apps/desktop/src/JsonReleaseProvider';
import { validateReleaseManifest } from './releaseService.js';

describe('JSON update protocol', () => {
  it.each([
    ['2026.101.0', 'v2026.01.01'], ['2026.1106.1', 'v2026.11.06-r2'], ['2024.229.12', 'v2024.02.29-r13'],
  ])('resolves historical release %s as %s', (version, tag) => {
    expect(releaseTagForVersion(version)).toBe(tag);
  });
  it.each(['0.1.0', '2026.229.0', '2026.1301.0', '../2026.1106.0', '2026.1106.-1', '2026.1106.9007199254740991'])('rejects unsupported base %s', version => {
    expect(() => releaseTagForVersion(version)).toThrow();
  });
  it.each(['https://github.com/fixture/PilotDeck/releases/download/', 'https://mirror.example/PilotDeck/'])('keeps historical maps on the same route: %s', base => {
    const name = 'PilotDeck-2026.1106.1-win-arm64-setup.exe';
    const provider = new JsonReleaseProvider({ provider: 'custom', updateProvider: JsonReleaseProvider,
      url: `${base}v2026.11.06-r2/`, updateInfo: { version: '2026.1106.1', files: [{ url: name, sha512: 'hash' }] } }, {} as never, {} as never);
    const file = new URL(`${base}v2026.11.06-r2/${name}`);
    expect(provider.getBlockMapFiles(file, '2026.1105.0', '2026.1106.1').map(url => url.href)).toEqual([
      `${base}v2026.11.05/PilotDeck-2026.1105.0-win-arm64-setup.exe.blockmap`, `${file.href}.blockmap`,
    ]);
    expect(() => provider.getBlockMapFiles(new URL('https://other.example/file.exe'), '2026.1105.0', '2026.1106.1')).toThrow();
    expect(() => provider.getBlockMapFiles(file, '2026.1105.0', '2026.1106.2')).toThrow();
  });
  it('pins validated metadata across mirror changes without reading a YAML feed', async () => {
    const file = { url: 'PilotDeck-2026.1029.0-win-x64-setup.exe', sha512: 'A'.repeat(86) + '==', size: 123 };
    const info = { version: '2026.1029.0', files: [file], path: file.url, sha512: file.sha512, releaseDate: '2026-10-29' };
    const executor = new Proxy({}, { get() { throw new Error('Unexpected metadata request'); } });
    const provider = new JsonReleaseProvider({ provider: 'custom', updateProvider: JsonReleaseProvider, url: 'https://mirror.example/v2026.10.29/', updateInfo: info }, {} as never,
      { platform: 'win32', executor: executor as never, isUseMultipleRangeRequest: true });
    info.version = '2026.1030.0';
    file.url = 'other.exe';
    const pinned = await provider.getLatestVersion();
    expect(pinned.version).toBe('2026.1029.0');
    expect(provider.resolveFiles(pinned)[0].url.href).toBe('https://mirror.example/v2026.10.29/PilotDeck-2026.1029.0-win-x64-setup.exe');
    pinned.files[0].url = 'mutated.exe';
    expect((await provider.getLatestVersion()).files[0].url).not.toBe('mutated.exe');
    expect(provider.isUseMultipleRangeRequest).toBe(false);
  });
  it('keeps old JSON readable and exposes DMGs only in macOS installer downloads', () => {
    const base = { schemaVersion: 1, tag: 'v2026.10.29', date: '2026-10-29', version: '2026.1029.0', repository: 'OpenBMB/PilotDeck', sourceSha: 'a'.repeat(40) };
    const assets = ['dmg', 'zip'].map(format => ({ name: `PilotDeck-2026.1029.0-mac-arm64.${format}`, platform: 'darwin', arch: 'arm64', size: 5, sha256: 'a'.repeat(64), sha512: 'A'.repeat(86) + '==' }));
    const old = validateReleaseManifest({ ...base, assets });
    expect(old.differentialUpdates).toBe(false);
    expect(validateReleaseManifest({ ...base, assets, differentialUpdates: true }).differentialUpdates).toBe(true);
    expect(validateReleaseManifest({ ...base, assets, differentialUpdates: 'true' }).differentialUpdates).toBe(false);
    expect(old.downloads.map(a => a.name)).toEqual([assets[0].name]);
    const modern = { ...base, artifactSchemaVersion: 1, assets: assets.map((a, i) => ({ ...a, format: i ? 'zip' : 'dmg', roles: [i ? 'update' : 'install'] })) };
    expect(validateReleaseManifest(modern).downloads.map(a => a.name)).toEqual([assets[0].name]);
    modern.assets[1].roles = ['install'];
    expect(() => validateReleaseManifest(modern)).toThrow('Invalid artifact roles');
  });
});
