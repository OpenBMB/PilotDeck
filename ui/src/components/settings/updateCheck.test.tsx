import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Settings from './Settings';

vi.mock('../../hooks/usePilotDeckConfig', () => ({ PilotDeckConfigProvider: ({ children }: any) => children }));
vi.mock('./view/SettingsSidebar', () => ({ default: () => null }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useLocation: () => ({ search: '' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const copy = (key: string) => `settingsPage.about.desktopUpdate.${key}`;
const release = (hasUpdate = true) => ({ current: { version: '2026.1001.0' }, latest: { version: hasUpdate ? '2026.1002.0' : '2026.1001.0' }, hasUpdate, canDownload: hasUpdate, checkUnavailable: false });
const bridge = { platform: 'darwin', checkUpdates: vi.fn(), getUpdateStatus: vi.fn(), startUpdate: vi.fn(), cancelUpdate: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('pilotdeckDesktop', bridge);
  bridge.getUpdateStatus.mockResolvedValue({ state: 'idle', progress: 0 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['offline', 'upToDate'])('refreshes the real Settings version state after %s and only installs after a second click', async (initial) => {
  if (initial === 'offline') bridge.checkUpdates.mockRejectedValueOnce(new Error('offline'));
  else bridge.checkUpdates.mockResolvedValueOnce(release(false));
  bridge.checkUpdates.mockResolvedValue(release());
  bridge.startUpdate.mockResolvedValue({ state: 'installing', progress: 1 });
  render(<Settings section="about" onClose={vi.fn()} />);
  await waitFor(() => expect((screen.getByRole('button', { name: copy('checkAgain') }) as HTMLButtonElement).disabled).toBe(false));
  expect(bridge.checkUpdates).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: copy('checkAgain') }));
  await waitFor(() => expect((screen.getByRole('button', { name: copy('updateAndRestart') }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText('settingsPage.about.latestVersion 2026.1002.0')).toBeTruthy();
  expect(bridge.checkUpdates).toHaveBeenCalledTimes(2); expect(bridge.startUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: copy('updateAndRestart') }));
  await waitFor(() => expect(bridge.startUpdate).toHaveBeenCalledTimes(1));
});

it('keeps the refresh action available after repeated failures without requesting installation', async () => {
  bridge.checkUpdates.mockRejectedValue(new Error('offline'));
  render(<Settings section="about" onClose={vi.fn()} />);
  await waitFor(() => expect((screen.getByRole('button', { name: copy('checkAgain') }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: copy('checkAgain') }));
  await waitFor(() => expect(bridge.checkUpdates).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((screen.getByRole('button', { name: copy('checkAgain') }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole('alert').textContent).toBe(copy('reasons.checkFailed'));
  expect(bridge.startUpdate).not.toHaveBeenCalled();
});
