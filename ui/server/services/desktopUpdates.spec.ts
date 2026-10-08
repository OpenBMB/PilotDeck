// @vitest-environment node
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { AppUpdater } from 'electron-updater';
import { createUpdateController, selectUpdateAssets, validateUpdateInfo, type Release } from '../../../apps/desktop/src/updates';

const checksum = 'a'.repeat(64);
const sha512 = 'A'.repeat(86) + '==';
const desktopRequire = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url));

function release(platform: string, arch: string, payload: string, feed: string): Release {
  return {
    version: '2026.928.0', tagName: 'v2026.09.28',
    assets: [
      { name: payload, size: 42, sha256: checksum, sha512, platform, arch },
      { name: feed, size: 10, sha256: checksum, sha512, platform, arch },
    ],
  };
}

describe('desktop update assets', () => {
  it.each(['x64', 'arm64'])('uses the exact Windows %s channel with the installed updater', (arch) => {
    const { GenericProvider } = desktopRequire('electron-updater/out/providers/GenericProvider');
    const provider = new GenericProvider({ url: 'https://example.invalid/' }, { channel: `latest-${arch}` }, { platform: 'win32', executor: {} });
    expect(provider.channel).toBe(`latest-${arch}`);
  });
  it('matches the Linux channel suffix used by the installed electron-updater', () => {
    const { GenericProvider } = desktopRequire('electron-updater/out/providers/GenericProvider');
    const previous = process.env.TEST_UPDATER_ARCH;
    try {
      for (const [arch, feed] of [['x64', 'latest-linux'], ['arm64', 'latest-linux-arm64']]) {
        process.env.TEST_UPDATER_ARCH = arch;
        const provider = new GenericProvider({ url: 'https://example.invalid/' }, { channel: 'latest' }, { platform: 'linux', executor: {} });
        expect(provider.channel).toBe(feed);
      }
    } finally {
      if (previous === undefined) delete process.env.TEST_UPDATER_ARCH;
      else process.env.TEST_UPDATER_ARCH = previous;
    }
  });

  it.each([
    ['darwin', 'arm64', 'PilotDeck-2026.928.0-mac-arm64.zip', 'latest-arm64-mac.yml'],
    ['darwin', 'x64', 'PilotDeck-2026.928.0-mac-x64.zip', 'latest-x64-mac.yml'],
    ['win32', 'x64', 'PilotDeck-2026.928.0-win-x64-setup.exe', 'latest-x64.yml'],
    ['win32', 'arm64', 'PilotDeck-2026.928.0-win-arm64-setup.exe', 'latest-arm64.yml'],
    ['linux', 'x64', 'PilotDeck-2026.928.0-linux-x64.deb', 'latest-linux.yml'],
    ['linux', 'arm64', 'PilotDeck-2026.928.0-linux-arm64.deb', 'latest-linux-arm64.yml'],
  ])('selects the %s %s package and feed', (platform, arch, payload, feed) => {
    const latest = release(platform, arch, payload, feed);
    expect(selectUpdateAssets(latest, platform, arch)).toMatchObject({ asset: latest.assets[0], feed });
    expect(validateUpdateInfo({ version: latest.version, files: [{ url: payload, sha512, size: 42 }] }, latest, platform, arch)).toEqual(latest.assets[0]);
    expect(() => validateUpdateInfo({ version: latest.version, files: [{ url: payload, sha512, size: 43 }] }, latest, platform, arch)).toThrow('invalidUpdateMetadata');
    expect(selectUpdateAssets({ ...latest, assets: latest.assets.slice(0, 1) }, platform, arch)).toBeNull();
  });

  it('requires the x64 Linux package name after checking the latest version', () => {
    const legacy = release('linux', 'x64', 'PilotDeck-2026.928.0-linux-amd64.deb', 'latest-linux.yml');
    expect(selectUpdateAssets(legacy, 'linux', 'x64')).toBeNull();
  });

  it('uses the native Linux feed name and installs a verified DEB', async () => {
    const latest = release('linux', 'arm64', 'PilotDeck-2026.928.0-linux-arm64.deb', 'latest-linux-arm64.yml');
    const updater = Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(async () => ({
        isUpdateAvailable: true,
        updateInfo: { version: latest.version, files: [{ url: latest.assets[0].name, sha512, size: 42 }] },
        cancellationToken: { cancel: vi.fn() },
      })),
      downloadUpdate: vi.fn(async () => ['/tmp/PilotDeck-test.deb']),
      quitAndInstall: vi.fn(),
    });
    const prepareToInstall = vi.fn();
    const verifyFile = vi.fn();
    const controller = createUpdateController({
      updater: updater as unknown as AppUpdater, repository: 'OpenBMB/PilotDeck',
      platform: 'linux', arch: 'arm64', version: '2026.927.0', packaged: true,
      latestRelease: async () => latest,
      compareVersions: (left, right) => left.localeCompare(right),
      prepareToInstall, recoverRuntime: vi.fn(), verifyFile,
    });
    expect(await controller.check()).toMatchObject({ hasUpdate: true, canDownload: true });
    controller.start();
    await controller.wait();
    expect(updater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'latest', url: 'https://github.com/OpenBMB/PilotDeck/releases/download/v2026.09.28/',
    }));
    expect(verifyFile).toHaveBeenCalledWith('/tmp/PilotDeck-test.deb', latest.assets[0]);
    expect(prepareToInstall).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(controller.status().state).toBe('installing');
  });
});
