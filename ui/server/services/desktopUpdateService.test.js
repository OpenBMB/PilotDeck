import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isDesktopRelease,
  mapGitHubRelease,
  normalizeRepository,
  normalizeDesktopReleaseVersion,
  parseVersionParts,
  selectDesktopAsset,
} from './desktopUpdateService.js';

describe('desktop release versions', () => {
  it('defaults desktop updates to the upstream repository', () => {
    expect(normalizeRepository()).toBe('OpenBMB/PilotDeck');
    expect(normalizeRepository('https://github.com/mssssss123/PilotDeck.git')).toBe('mssssss123/PilotDeck');
  });

  it('maps a dated desktop tag to the packaged semver', () => {
    expect(normalizeDesktopReleaseVersion('desktop-v2026.09.02')).toBe('2026.902.0');
    expect(normalizeDesktopReleaseVersion('desktop-v2026.09.02-r2')).toBe('2026.902.1');
  });

  it('compares dated tags with packaged versions consistently', () => {
    expect(compareVersions('2026.902.0', 'desktop-v2026.09.02')).toBe(0);
    expect(compareVersions('2026.901.0', 'desktop-v2026.09.02')).toBe(-1);
    expect(compareVersions('2026.902.0', 'desktop-v2026.09.02-r2')).toBe(-1);
    expect(parseVersionParts('desktop-v2026.01.02')).toEqual([2026, 102, 0]);
  });

  it('recognizes only desktop release tags', () => {
    expect(isDesktopRelease({ tagName: 'desktop-v2026.09.02' })).toBe(true);
    expect(isDesktopRelease({ tagName: 'v1.2.3' })).toBe(false);
  });

  it('exposes the normalized version from GitHub releases', () => {
    expect(mapGitHubRelease({ tag_name: 'desktop-v2026.09.02-r2' }).version).toBe('2026.902.1');
  });

  it('selects the native macOS installer for the current architecture', () => {
    const release = {
      assets: [
        { name: 'PilotDeck-2026.903.0-mac-x64.dmg' },
        { name: 'PilotDeck-2026.903.0-mac-arm64.dmg' },
        { name: 'PilotDeck-2026.903.0-mac-universal.dmg' },
      ],
    };

    expect(selectDesktopAsset(release, { platform: 'darwin', arch: 'arm64' })?.name)
      .toBe('PilotDeck-2026.903.0-mac-arm64.dmg');
    expect(selectDesktopAsset(release, { platform: 'darwin', arch: 'x64' })?.name)
      .toBe('PilotDeck-2026.903.0-mac-x64.dmg');
  });

  it('never offers a macOS installer built only for another architecture', () => {
    const release = {
      assets: [{ name: 'PilotDeck-2026.903.0-mac-x64.dmg' }],
    };

    expect(selectDesktopAsset(release, { platform: 'darwin', arch: 'arm64' })).toBeNull();
  });
});
