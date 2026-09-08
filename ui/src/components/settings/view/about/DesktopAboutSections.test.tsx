import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AboutSections from ".";
import type { DesktopVersionCheckResult } from "../../Settings";
const bridge = vi.hoisted(() => ({ getUpdateStatus: vi.fn(), startUpdate: vi.fn(), cancelUpdate: vi.fn() }));
vi.mock("../../../../utils/desktopUpdates", () => ({ desktopUpdates: () => bridge }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const copy = (key: string) => `settingsPage.about.desktopUpdate.${key}`;
function show(props: Partial<DesktopVersionCheckResult> = {}) {
  return render(<AboutSections title="About" checkingVersion={false} versionInfo={{
    mode: "desktop", currentVersion: "2026.906.0", latestVersion: "2026.907.0", latestPublishedAt: null,
    hasUpdate: true, canDownload: true, checkUnavailable: false, buildTime: null, ...props,
  }} />);
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
beforeEach(() => { vi.resetAllMocks(); bridge.getUpdateStatus.mockResolvedValue({ state: 'idle', progress: 0 }); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });
describe('desktop automatic update UI', () => {
  it.each([
    { canDownload: false, desktopReason: 'noCompatibleInstaller' },
    { canDownload: false, hasUpdate: false },
    { canDownload: false, checkUnavailable: true, desktopReason: 'checkFailed' },
  ])('disables unavailable updates', async (props) => {
    show(props); await flush();
    const button = screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button); expect(bridge.startUpdate).not.toHaveBeenCalled();
  });
  it('one click starts the native update; progress advances to automatic installation', async () => {
    vi.useFakeTimers(); show(); await flush();
    bridge.startUpdate.mockResolvedValue({ state: 'downloading', progress: .42 });
    bridge.getUpdateStatus.mockResolvedValue({ state: 'downloading', progress: .42 });
    fireEvent.click(screen.getByRole('button', { name: copy('updateAndRestart') })); await flush();
    expect(bridge.startUpdate).toHaveBeenCalledTimes(1); expect(screen.getByText('42%')).toBeTruthy();
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
  it('keeps updating disabled until main-process status is known', async () => {
    vi.useFakeTimers(); bridge.getUpdateStatus.mockRejectedValueOnce(new Error('network'));
    show(); await flush(); expect((screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement).disabled).toBe(true);
    await tick(); expect((screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement).disabled).toBe(false);
  });
  it.each([['checksumMismatch', false], ['installFailed', true]])('explains %s and enforces its retry policy', async (reason, disabled) => {
    bridge.getUpdateStatus.mockResolvedValue({ state: 'failed', reason, progress: 0 }); show(); await flush();
    expect(screen.getByRole('alert').textContent).toBe(copy(`reasons.${reason}`));
    expect((screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement).disabled).toBe(disabled);
  });
  it('cancels through Electron and offers a new attempt', async () => {
    bridge.getUpdateStatus.mockResolvedValue({ state: 'downloading', progress: .3 });
    bridge.cancelUpdate.mockResolvedValue({ state: 'cancelled', reason: 'cancelled', progress: .3 });
    show(); await flush(); fireEvent.click(screen.getByRole('button', { name: copy('cancel') })); await flush();
    expect(bridge.cancelUpdate).toHaveBeenCalledTimes(1); expect(screen.getByRole('alert').textContent).toBe(copy('reasons.cancelled'));
    expect((screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement).disabled).toBe(false);
  });
});
