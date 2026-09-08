// @vitest-environment node
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createUpdateController, selectUpdateAssets, validateUpdateInfo, verifyDownloadedFile, type Release } from '../../../apps/desktop/src/updates';
import { compareVersions } from './releaseService.js';
const asset = (platform = 'darwin', arch = 'arm64') => ({ name: `PilotDeck-${platform}-${arch}${platform === 'darwin' ? '.zip' : '-setup.exe'}`,
  platform, arch, size: 5, sha256: 'a'.repeat(64), sha512: 'A'.repeat(86) + '==' });
const releaseFor = (platform = 'darwin', arch = 'arm64'): Release => ({ version: '2026.907.1', tagName: 'v2026.09.07-r2', assets: [asset(platform, arch),
  { ...asset(platform, arch), name: `latest-${arch}${platform === 'darwin' ? '-mac' : ''}.yml` }] });
const infoFor = (release: Release) => ({ version: release.version, files: release.assets.filter(a => !a.name.endsWith('.yml')).map(a => ({ url: a.name, sha512: a.sha512!, size: a.size })) });
function setup(overrides: Record<string, unknown> = {}) {
  const release = releaseFor();
  const cancel = vi.fn();
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(), quitAndInstall: vi.fn(), checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: infoFor(release), cancellationToken: { cancel } })),
    downloadUpdate: vi.fn(async () => ['/tmp/pilotdeck-auto-update-test-missing.zip']),
  });
  const prepareToInstall = vi.fn();
  const recoverRuntime = vi.fn();
  const verifyFile = vi.fn();
  const latestRelease = vi.fn(async () => release);
  const controller = createUpdateController({ updater: updater as unknown as Parameters<typeof createUpdateController>[0]["updater"], repository: 'OpenBMB/PilotDeck', platform: 'darwin', arch: 'arm64',
    version: '2026.907.0', packaged: true, compareVersions, latestRelease, prepareToInstall, recoverRuntime, verifyFile, ...overrides });
  return { controller, updater, cancel, release, latestRelease, prepareToInstall, recoverRuntime, verifyFile };
}
describe('automatic update policy', () => {
  it.each([['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']])('requires the exact %s %s payload and feed', (platform, arch) => {
    const release = releaseFor(platform, arch);
    expect(selectUpdateAssets(release, platform, arch)?.asset).toEqual(asset(platform, arch));
    expect(selectUpdateAssets(release, platform, 'other')).toBeNull();
    expect(selectUpdateAssets({ ...release, assets: release.assets.slice(0, 1) }, platform, arch)).toBeNull();
  });
  it('refuses dev runtimes, equal versions, downgrades and missing packages', async () => {
    for (const overrides of [{ packaged: false }, { version: '2026.907.1' }, { version: '2026.908.0' }, { latestRelease: async () => ({ ...releaseFor(), assets: [] }) }]) {
      const { controller, updater } = setup(overrides);
      expect((await controller.check()).canDownload).toBe(false);
      controller.start(); await controller.wait(); expect(updater.downloadUpdate).not.toHaveBeenCalled();
    }
  });
  it('validates metadata version, architecture, checksums, sizes and relative file names', () => {
    const release = releaseFor(); const info = infoFor(release);
    expect(validateUpdateInfo(info, release, 'darwin', 'arm64')).toEqual(release.assets[0]);
    for (const changes of [{ version: '2026.907.2' }, { files: [{ ...info.files[0], url: 'https://other/file.zip' }] },
      { files: [{ ...info.files[0], sha512: 'wrong' }] }, { files: [{ ...info.files[0], size: 6 }] }, { packages: { x64: { path: 'other' } } }]) {
      expect(() => validateUpdateInfo({ ...info, ...changes }, release, 'darwin', 'arm64')).toThrow('invalidUpdateMetadata');
    }
    expect(() => validateUpdateInfo(info, release, 'darwin', 'x64')).toThrow();
  });
});
describe('automatic update lifecycle', () => {
  it('one click downloads, verifies, stops services then installs and relaunches', async () => {
    const { controller, updater, prepareToInstall, verifyFile } = setup();
    expect(controller.start().state).toBe('checking'); await controller.wait();
    expect(controller.status().state).toBe('installing');
    expect(updater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://github.com/OpenBMB/PilotDeck/releases/download/v2026.09.07-r2/', channel: 'latest-arm64' }));
    expect(verifyFile.mock.invocationCallOrder[0]).toBeLessThan(prepareToInstall.mock.invocationCallOrder[0]);
    expect(prepareToInstall.mock.invocationCallOrder[0]).toBeLessThan(updater.quitAndInstall.mock.invocationCallOrder[0]);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, autoRunAppAfterInstall: true });
  });
  it('locks concurrent starts and cancellation during discovery never installs', async () => {
    let resolve!: (release: Release) => void;
    const { controller, updater, latestRelease } = setup({ latestRelease: vi.fn(() => new Promise(r => { resolve = r; })) });
    controller.start(); controller.start(); controller.cancel(); await vi.waitFor(() => expect(resolve).toBeTypeOf("function")); resolve(releaseFor()); await controller.wait();
    expect(controller.status().state).toBe('cancelled'); expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });
  it('freezes proxy configuration while downloading, including concurrent checks', async () => {
    const prepareNetwork = vi.fn();
    const { controller, updater } = setup({ prepareNetwork });
    let resolve!: (files: string[]) => void;
    updater.downloadUpdate.mockImplementation(() => new Promise(r => { resolve = r; }));
    controller.start(); await vi.waitFor(() => expect(controller.status().state).toBe('downloading'));
    await controller.check(); await controller.check();
    expect(prepareNetwork).toHaveBeenCalledTimes(1);
    controller.cancel(); resolve(['/tmp/file']); await controller.wait();
    await controller.check();
    expect(prepareNetwork).toHaveBeenCalledTimes(2);
  });
  it('does not discover or download when proxy initialization fails', async () => {
    const { controller, updater, latestRelease } = setup({ prepareNetwork: async () => { throw new Error('proxy failed'); } });
    expect(await controller.check()).toMatchObject({ checkUnavailable: true, reason: 'checkFailed' });
    controller.start(); await controller.wait();
    expect(latestRelease).not.toHaveBeenCalled(); expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });
  it('cancels download through the updater token and never stops services', async () => {
    const { controller, updater, cancel, prepareToInstall } = setup();
    let resolve!: (files: string[]) => void;
    updater.downloadUpdate.mockImplementation(() => new Promise(r => { resolve = r; }));
    controller.start(); await vi.waitFor(() => expect(controller.status().state).toBe('downloading'));
    updater.emit('download-progress', { percent: 42 }); expect(controller.status().progress).toBe(.42);
    controller.cancel(); resolve(['/tmp/file']); await controller.wait();
    expect(cancel).toHaveBeenCalled(); expect(prepareToInstall).not.toHaveBeenCalled(); expect(controller.status().state).toBe('cancelled');
  });
  it('does not stop the runtime after download or checksum failure', async () => {
    for (const failVerify of [false, true]) {
      const { controller, updater, verifyFile, prepareToInstall } = setup();
      if (failVerify) verifyFile.mockRejectedValue(new Error('checksumMismatch'));
      else updater.downloadUpdate.mockRejectedValue(new Error('network'));
      controller.start(); await controller.wait();
      expect(controller.status().state).toBe('failed'); expect(prepareToInstall).not.toHaveBeenCalled(); expect(updater.quitAndInstall).not.toHaveBeenCalled();
    }
  });
  it('restores services after a native install error and requires app restart before retry', async () => {
    const { controller, updater, recoverRuntime } = setup();
    controller.start(); await controller.wait(); updater.emit('error', new Error('signature rejected'));
    await vi.waitFor(() => expect(controller.status()).toMatchObject({ state: 'failed', reason: 'installFailed' }));
    expect(recoverRuntime).toHaveBeenCalledTimes(1); controller.start(); expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
  it('recovers when runtime shutdown fails', async () => {
    const { controller, updater, recoverRuntime } = setup({ prepareToInstall: async () => { throw new Error('stop failed'); } });
    controller.start(); await controller.wait(); expect(recoverRuntime).toHaveBeenCalled(); expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('keeps restart-required failure visible when runtime recovery also fails', async () => {
    const { controller, updater } = setup({
      prepareToInstall: async () => { throw new Error('stop failed'); },
      recoverRuntime: async () => { throw new Error('restart failed'); },
    });
    controller.start(); await controller.wait();
    expect(controller.status()).toMatchObject({ state: 'failed', reason: 'installFailed' });
    controller.start(); expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
  it('revalidates bytes on disk, including a modified cached update', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-auto-test-'));
    try {
      const file = path.join(directory, 'update.zip'); const body = Buffer.from('valid'); await writeFile(file, body);
      const expected = { ...asset(), sha256: createHash('sha256').update(body).digest('hex') };
      await expect(verifyDownloadedFile(file, expected)).resolves.toBeUndefined();
      await writeFile(file, 'wrong'); await expect(verifyDownloadedFile(file, expected)).rejects.toThrow('checksumMismatch');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
