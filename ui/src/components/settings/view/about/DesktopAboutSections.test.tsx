import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopVersionCheckResult } from "../../Settings";
import AboutSections from ".";
const bridge = vi.hoisted(() => ({ getUpdateStatus: vi.fn(), startUpdate: vi.fn(), cancelUpdate: vi.fn(), pauseUpdate: vi.fn(), resumeUpdate: vi.fn() }));
vi.mock("../../../../utils/desktopUpdates", () => ({ desktopUpdates: () => bridge }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const copy = (key: string) => `settingsPage.about.desktopUpdate.${key}`;
const checkAgain = vi.fn();
function show(props: Partial<DesktopVersionCheckResult> = {}) {
  return render(<AboutSections title="About" checkingVersion={false} onCheckUpdates={checkAgain} versionInfo={{
    mode: "desktop", currentVersion: "2026.906.0", latestVersion: "2026.907.0", latestPublishedAt: null,
    hasUpdate: true, canDownload: true, checkUnavailable: false, buildTime: null, ...props,
  }} />);
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('pilotdeckDesktop', bridge); bridge.getUpdateStatus.mockResolvedValue({ state: 'idle', progress: 0 }); checkAgain.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('desktop automatic update UI', () => {
  it('shows the release date from the manifest without inventing a time of day', async () => {
    show({ latestPublishedAt: '2026-09-07' }); await flush();
    expect(screen.getByText('settingsPage.about.latestReleaseTime 2026-09-07')).toBeTruthy();
  });
  it.each([
    { canDownload: false, desktopReason: 'noCompatibleInstaller' },
    { canDownload: false, hasUpdate: false },
    { canDownload: false, checkUnavailable: true, desktopReason: 'checkFailed' },
  ])('offers a fresh check when no downloadable update is available', async (props) => {
    show(props); await flush();
    const button = screen.getByRole('button', { name: copy('checkAgain') }) as HTMLButtonElement;
    expect(button.disabled).toBe(false); fireEvent.click(button); await flush();
    expect(checkAgain).toHaveBeenCalledTimes(1); expect(bridge.startUpdate).not.toHaveBeenCalled();
    expect(bridge.getUpdateStatus).toHaveBeenCalledTimes(2);
  });
  it('one click starts the native update; progress advances to automatic installation', async () => {
    vi.useFakeTimers(); show(); await flush();
    bridge.startUpdate.mockResolvedValue({ state: 'downloading', progress: .42, bytesPerSecond: 2 * 1024 * 1024 });
    bridge.getUpdateStatus.mockResolvedValue({ state: 'downloading', progress: .42, bytesPerSecond: 2 * 1024 * 1024 });
    fireEvent.click(screen.getByRole('button', { name: copy('updateAndRestart') })); await flush();
    expect(bridge.startUpdate).toHaveBeenCalledTimes(1); expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText(`${copy('speed')} 2.0 MB/s`)).toBeTruthy();
    bridge.getUpdateStatus.mockResolvedValue({ state: 'downloading', progress: .5, bytesPerSecond: 512 * 1024 }); await tick();
    expect(screen.getByText(`${copy('speed')} 512.0 KB/s`)).toBeTruthy();
    bridge.getUpdateStatus.mockResolvedValue({ state: 'verifying', progress: 1 }); await tick();
    expect(screen.queryByRole('button', { name: copy('cancel') })).toBeNull();
    bridge.getUpdateStatus.mockResolvedValue({ state: 'installing', progress: 1 }); await tick();
    expect(screen.getByRole('status').textContent).toBe(copy('status.installing'));
    expect(screen.getByText(copy('reasons.installing'))).toBeTruthy();
    expect((screen.getByRole('button', { name: copy('updating') }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('recovers progress after reopening and keeps polling through transient IPC errors', async () => {
    vi.useFakeTimers(); bridge.getUpdateStatus.mockResolvedValue({ state: 'downloading', progress: .5 });
    const view = show(); await flush(); expect(screen.getByText('50%')).toBeTruthy();
    bridge.getUpdateStatus.mockRejectedValueOnce(new Error('temporary')); await tick();
    expect(screen.getByRole('alert').textContent).toBe(copy('reasons.statusFailed'));
    bridge.getUpdateStatus.mockResolvedValue({ state: 'installing', progress: 1 }); await tick();
    expect(screen.getByRole('status').textContent).toBe(copy('status.installing'));
    view.unmount(); const count = bridge.getUpdateStatus.mock.calls.length; await tick(); expect(bridge.getUpdateStatus).toHaveBeenCalledTimes(count);
  });
  it('does not show the default click explanation when no update is running', async () => {
    show({ hasUpdate: false, canDownload: false, latestVersion: '2026.906.0' }); await flush();
    expect(screen.queryByText(copy('reasons.automatic'))).toBeNull();
    expect(screen.queryByText(copy('speed'), { exact: false })).toBeNull();
  });
  it('keeps updating disabled until main-process status is known', async () => {
    vi.useFakeTimers(); bridge.getUpdateStatus.mockRejectedValueOnce(new Error('network'));
    show(); expect((screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement).disabled).toBe(true);
    await flush(); expect((screen.getByRole('button', { name: copy('checkAgain') }) as HTMLButtonElement).disabled).toBe(false);
    await tick(); expect((screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement).disabled).toBe(false);
  });
  it.each(['checksumMismatch', 'invalidUpdateMetadata', 'updateFailed', 'installFailed'])('explains %s and offers a check before retrying', async (reason) => {
    bridge.getUpdateStatus.mockResolvedValue({ state: 'failed', reason, progress: 0 }); show(); await flush();
    expect(screen.getByRole('alert').textContent).toBe(copy(`reasons.${reason}`));
    const button = screen.getByRole('button', { name: copy('checkAgain') }) as HTMLButtonElement;
    expect(button.disabled).toBe(false); fireEvent.click(button); await flush();
    expect(checkAgain).toHaveBeenCalledTimes(1); expect(bridge.startUpdate).not.toHaveBeenCalled();
  });
  it('removes the build information card on macOS', async () => {
    const getAboutInfo = vi.fn(); vi.stubGlobal('pilotdeckDesktop', { ...bridge, platform: 'darwin', getAboutInfo });
    show(); await flush();
    expect(getAboutInfo).not.toHaveBeenCalled();
    expect(screen.queryByText('Electron')).toBeNull();
    expect(screen.queryByText('settingsPage.about.platform')).toBeNull();
    expect(screen.getByText('settingsPage.about.currentVersion 2026.906.0')).toBeTruthy();
  });
  it('locks the check button while refreshing and switches to installing when a new release is found', async () => {
    let finish!: () => void;
    checkAgain.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = show({ hasUpdate: false, canDownload: false }); await flush();
    fireEvent.click(screen.getByRole('button', { name: copy('checkAgain') }));
    const checking = screen.getByRole('button', { name: copy('checking') }) as HTMLButtonElement;
    expect(checking.disabled).toBe(true); fireEvent.click(checking); expect(checkAgain).toHaveBeenCalledTimes(1);
    view.rerender(<AboutSections title="About" checkingVersion={false} onCheckUpdates={checkAgain} versionInfo={{
      mode: 'desktop', currentVersion: '2026.906.0', latestVersion: '2026.908.0', latestPublishedAt: null,
      hasUpdate: true, canDownload: true, checkUnavailable: false, buildTime: null,
    }} />);
    expect(screen.getByRole('button', { name: copy('checking') })).toBeTruthy();
    finish(); await flush();
    expect((screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement).disabled).toBe(false);
    expect(bridge.startUpdate).not.toHaveBeenCalled();
  });
  it('allows another check after refreshing fails', async () => {
    checkAgain.mockRejectedValue(new Error('IPC disconnected'));
    show({ hasUpdate: false, canDownload: false }); await flush();
    bridge.getUpdateStatus.mockRejectedValue(new Error('IPC disconnected'));
    fireEvent.click(screen.getByRole('button', { name: copy('checkAgain') })); await flush();
    expect(screen.getByRole('alert').textContent).toBe(copy('reasons.statusFailed'));
    expect((screen.getByRole('button', { name: copy('checkAgain') }) as HTMLButtonElement).disabled).toBe(false);
    expect(bridge.startUpdate).not.toHaveBeenCalled();
  });
  it('cancels through Electron and offers a new attempt', async () => {
    bridge.getUpdateStatus.mockResolvedValue({ state: 'downloading', progress: .3 });
    bridge.cancelUpdate.mockResolvedValue({ state: 'cancelled', reason: 'cancelled', progress: .3 });
    show(); await flush(); fireEvent.click(screen.getByRole('button', { name: copy('cancel') })); await flush();
    expect(bridge.cancelUpdate).toHaveBeenCalledTimes(1); expect(screen.getByRole('alert').textContent).toBe(copy('reasons.cancelled'));
    expect((screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('pauses and resumes the same download, preserves byte counts and keeps polling', async () => {
    vi.useFakeTimers();
    const downloading = { state: 'downloading', progress: .42, transferred: 84 * 1024 * 1024, total: 200 * 1024 * 1024, bytesPerSecond: 2 * 1024 * 1024 };
    const paused = { ...downloading, state: 'paused', bytesPerSecond: 0 };
    bridge.getUpdateStatus.mockResolvedValue(downloading);
    bridge.pauseUpdate.mockImplementation(async () => { bridge.getUpdateStatus.mockResolvedValue(paused); return paused; });
    show(); await flush();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('84.0 MB / 200.0 MB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy('pause') })); await flush();
    expect(bridge.pauseUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe(copy('status.paused'));
    expect(screen.getByText(`${copy('speed')} —`)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    const polls = bridge.getUpdateStatus.mock.calls.length; await tick();
    expect(bridge.getUpdateStatus.mock.calls.length).toBeGreaterThan(polls);
    bridge.resumeUpdate.mockImplementation(async () => { bridge.getUpdateStatus.mockResolvedValue(downloading); return downloading; });
    fireEvent.click(screen.getByRole('button', { name: copy('resume') })); await flush();
    expect(bridge.resumeUpdate).toHaveBeenCalledTimes(1);
    expect(bridge.startUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: copy('pause') })).toBeTruthy();
  });
  it('restores a paused download after reopening and can cancel it', async () => {
    bridge.getUpdateStatus.mockResolvedValue({ state: 'paused', progress: .3, transferred: 30, total: 100 });
    bridge.cancelUpdate.mockResolvedValue({ state: 'cancelling', progress: .3 });
    show(); await flush();
    expect(screen.getByRole('button', { name: copy('resume') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy('cancel') })); await flush();
    expect(bridge.cancelUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: copy('pause') })).toBeNull();
    expect(screen.queryByRole('button', { name: copy('resume') })).toBeNull();
  });
  it('locks actions while a pause request is pending', async () => {
    bridge.getUpdateStatus.mockResolvedValue({ state: 'downloading', progress: .3 });
    let resolve!: (state: unknown) => void;
    bridge.pauseUpdate.mockImplementation(() => new Promise(r => { resolve = r; }));
    show(); await flush();
    fireEvent.click(screen.getByRole('button', { name: copy('pause') }));
    expect((screen.getByRole('button', { name: copy('cancel') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: copy('pause') }));
    expect(bridge.pauseUpdate).toHaveBeenCalledTimes(1);
    resolve({ state: 'paused', progress: .3 }); await flush();
  });
  it.each([false, true])('does not let an earlier poll overwrite the pause result (failure: %s)', async (failure) => {
    vi.useFakeTimers();
    bridge.getUpdateStatus.mockResolvedValue({ state: 'downloading', progress: .3 });
    show(); await flush();
    let resolvePoll!: (state: unknown) => void;
    let rejectPoll!: (error: Error) => void;
    bridge.getUpdateStatus.mockImplementationOnce(() => new Promise((resolve, reject) => { resolvePoll = resolve; rejectPoll = reject; }));
    await tick();
    bridge.pauseUpdate.mockResolvedValue({ state: 'paused', progress: .3 });
    fireEvent.click(screen.getByRole('button', { name: copy('pause') })); await flush();
    if (failure) rejectPoll(new Error('stale failure'));
    else resolvePoll({ state: 'downloading', progress: .4 });
    await flush();
    expect(screen.getByRole('status').textContent).toBe(copy('status.paused'));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
