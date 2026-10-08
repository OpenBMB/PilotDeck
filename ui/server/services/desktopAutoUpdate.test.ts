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
  it.each([['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['win32', 'arm64']])('requires the exact %s %s payload and feed', (platform, arch) => {
    const release = releaseFor(platform, arch);
    expect(selectUpdateAssets(release, platform, arch)?.asset).toEqual(asset(platform, arch));
    expect(selectUpdateAssets(release, platform, 'other')).toBeNull();
    expect(selectUpdateAssets({ ...release, assets: release.assets.slice(0, 1) }, platform, arch)).toBeNull();
  });
  it.each(['x64', 'arm64'])('keeps Windows %s updates on their own architecture feed', async (arch) => {
    const own = releaseFor('win32', arch);
    const other = releaseFor('win32', arch === 'arm64' ? 'x64' : 'arm64');
    const release = { ...own, assets: [...own.assets, ...other.assets] };
    const info = infoFor(own);
    expect(selectUpdateAssets(release, 'win32', arch)).toEqual({ asset: own.assets[0], feed: `latest-${arch}.yml` });
    expect(validateUpdateInfo(info, release, 'win32', arch)).toEqual(own.assets[0]);
    expect(() => validateUpdateInfo(infoFor(other), release, 'win32', arch)).toThrow('invalidUpdateMetadata');
    expect(() => validateUpdateInfo(infoFor(release), release, 'win32', arch)).toThrow('invalidUpdateMetadata');
    expect(selectUpdateAssets(other, 'win32', arch)).toBeNull();
    const { controller, updater } = setup({ platform: 'win32', arch, latestRelease: async () => release });
    updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: info, cancellationToken: { cancel: vi.fn() } });
    controller.start(); await controller.wait();
    expect(updater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ channel: `latest-${arch}` }));
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.autoRunAppAfterInstall).toBe(false);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it.each(['x64', 'arm64'])('keeps DEB and RPM updates separate on Linux %s', async (arch) => {
    const deb = { ...asset('linux', arch), name: `PilotDeck-linux-${arch}.deb` };
    const rpm = { ...deb, name: `PilotDeck-linux-${arch}.rpm` };
    const release: Release = { version: '2026.907.1', tagName: 'v2026.09.07-r2', assets: [deb, rpm,
      { ...deb, name: `latest-linux${arch === 'arm64' ? '-arm64' : ''}.yml` },
      { ...rpm, name: `latest-rpm-linux${arch === 'arm64' ? '-arm64' : ''}.yml` }] };
    for (const type of ['deb', 'rpm']) {
      const expected = type === 'rpm' ? rpm : deb;
      const selected = selectUpdateAssets(release, 'linux', arch, type)!;
      expect(selected.asset).toEqual(expected);
      expect(selected.feed).toBe(`latest${type === 'rpm' ? '-rpm' : ''}-linux${arch === 'arm64' ? '-arm64' : ''}.yml`);
      expect(validateUpdateInfo({ version: release.version, files: [{ url: expected.name, sha512: expected.sha512, size: expected.size }] }, release, 'linux', arch, type)).toEqual(expected);
      const wrong = type === 'rpm' ? deb : rpm;
      expect(() => validateUpdateInfo({ version: release.version, files: [{ url: wrong.name, sha512: wrong.sha512, size: wrong.size }] }, release, 'linux', arch, type)).toThrow('invalidUpdateMetadata');
      expect(() => validateUpdateInfo({ version: release.version, files: [expected, wrong].map(a => ({ url: a.name, sha512: a.sha512, size: a.size })) }, release, 'linux', arch, type)).toThrow('invalidUpdateMetadata');
      expect(selectUpdateAssets({ ...release, assets: release.assets.filter(a => a.name !== expected.name) }, 'linux', arch, type)).toBeNull();
      const { controller, updater } = setup({ platform: 'linux', arch, linuxPackageType: type, latestRelease: async () => release });
      updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: release.version, files: [{ url: expected.name, sha512: expected.sha512, size: expected.size }] }, cancellationToken: { cancel: vi.fn() } });
      controller.start(); await controller.wait();
      expect(updater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ channel: type === 'rpm' ? 'latest-rpm' : 'latest' }));
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    }
    expect(selectUpdateAssets(release, 'linux', arch, 'unknown')).toBeNull();
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
  it('keeps a paused download locked and resumes without another check or download', async () => {
    const downloadControl = { pause: vi.fn(), resume: vi.fn() };
    const { controller, updater, prepareToInstall } = setup({ downloadControl });
    let resolve!: (files: string[]) => void;
    updater.downloadUpdate.mockImplementation(() => new Promise(r => { resolve = r; }));
    controller.start(); await vi.waitFor(() => expect(controller.status().state).toBe('downloading'));
    updater.emit('download-progress', { percent: 42, total: 100, transferred: 42, bytesPerSecond: 20 });
    expect(controller.pause()).toMatchObject({ state: 'paused', progress: .42, transferred: 42, total: 100, bytesPerSecond: 0 });
    expect(downloadControl.pause).toHaveBeenCalledTimes(1);
    updater.emit('download-progress', { percent: 60, total: 100, transferred: 60 });
    expect(controller.status().progress).toBe(.42);
    controller.start(); await controller.check();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    resolve(['/tmp/file']); await new Promise(r => setImmediate(r));
    expect(prepareToInstall).not.toHaveBeenCalled();
    expect(controller.resume()).toMatchObject({ state: 'downloading', progress: .42 });
    await controller.wait();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it('cancels a completed but paused payload without verifying or installing', async () => {
    const { controller, updater, cancel, verifyFile, prepareToInstall } = setup();
    let resolve!: (files: string[]) => void;
    updater.downloadUpdate.mockImplementation(() => new Promise(r => { resolve = r; }));
    controller.start(); await vi.waitFor(() => expect(controller.status().state).toBe('downloading'));
    controller.pause(); resolve(['/tmp/file']); await new Promise(r => setImmediate(r));
    expect(controller.cancel().state).toBe('cancelling');
    await controller.wait();
    expect(controller.status().state).toBe('cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(verifyFile).not.toHaveBeenCalled(); expect(prepareToInstall).not.toHaveBeenCalled();
  });
  it('rejects pause/resume outside downloading and preserves installation policy', async () => {
    const { controller, updater } = setup();
    expect(controller.pause().state).toBe('idle'); expect(controller.resume().state).toBe('idle');
    controller.start(); await controller.wait();
    expect(controller.pause().state).toBe('installing'); expect(controller.resume().state).toBe('installing');
    expect(controller.cancel().state).toBe('installing');
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it('excludes paused time from the next download speed sample', async () => {
    const { controller, updater } = setup();
    let resolve!: (files: string[]) => void;
    updater.downloadUpdate.mockImplementation(() => new Promise(r => { resolve = r; }));
    controller.start(); await vi.waitFor(() => expect(controller.status().state).toBe('downloading'));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    updater.emit('download-progress', { percent: 20, total: 1000, transferred: 200 });
    controller.pause(); now.mockReturnValue(60000); controller.resume(); now.mockReturnValue(61000);
    updater.emit('download-progress', { percent: 40, total: 1000, transferred: 400 });
    expect(controller.status().bytesPerSecond).toBe(200);
    now.mockRestore(); controller.cancel(); resolve(['/tmp/file']); await controller.wait();
  });
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
  it('clears a previous download failure after a successful fresh check without downloading', async () => {
    const { controller, updater, latestRelease } = setup();
    updater.downloadUpdate.mockRejectedValueOnce(new Error('network'));
    controller.start(); await controller.wait();
    expect(controller.status()).toMatchObject({ state: 'failed', reason: 'updateFailed' });
    expect(await controller.check()).toMatchObject({ hasUpdate: true, canDownload: true, checkUnavailable: false });
    expect(controller.status()).toEqual({ state: 'idle', progress: 0 });
    expect(latestRelease).toHaveBeenCalledTimes(2); expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    controller.start(); await controller.wait(); expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
  });
  it('preserves a download failure if the fresh check also fails', async () => {
    const { controller, updater, latestRelease } = setup();
    updater.downloadUpdate.mockRejectedValueOnce(new Error('network'));
    controller.start(); await controller.wait();
    latestRelease.mockRejectedValueOnce(new Error('offline'));
    expect(await controller.check()).toMatchObject({ canDownload: false, checkUnavailable: true, reason: 'checkFailed' });
    expect(controller.status()).toMatchObject({ state: 'failed', reason: 'updateFailed' });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
  it('restores services after a native install error and requires app restart before retry', async () => {
    const { controller, updater, recoverRuntime } = setup();
    controller.start(); await controller.wait(); updater.emit('error', new Error('signature rejected'));
    await vi.waitFor(() => expect(controller.status()).toMatchObject({ state: 'failed', reason: 'installFailed' }));
    expect(await controller.check()).toMatchObject({ hasUpdate: true, canDownload: false, reason: 'installFailed' });
    expect(controller.status()).toMatchObject({ state: 'failed', reason: 'installFailed' });
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
