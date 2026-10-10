import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComputerUseStatus } from '../../../../../shared/computerUse';
import { authenticatedFetch } from '../../../../utils/api';
import ComputerUseSections from '.';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  cleanup(); delete window.pilotdeckDesktop; vi.resetAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});
const disabled: ComputerUseStatus = { enabled: false, phase: 'disabled', platform: 'darwin', version: '0.34.1', available: true,
  permissionOwner: 'CuaDriver', permissions: { accessibility: false, screenRecording: false } };
function install(failedEnable = false, initial = disabled) {
  const fetch = vi.mocked(authenticatedFetch);
  fetch.mockImplementation(async (url: string, options: RequestInit = {}) => {
    const body = options.body ? JSON.parse(String(options.body)) : {};
    const result = url.endsWith('/enabled') ? { ...initial, enabled: body.enabled, phase: body.enabled ? 'needs-permissions' : 'disabled' } : initial;
    const failed = failedEnable && url.endsWith('/enabled');
    return { ok: !failed, json: async () => failed ? { error: 'failed to save' } : result } as Response;
  });
  return fetch;
}
it.each(['browser', 'desktop'])('%s renders the same controls and uses the HTTP API', async mode => {
  const fetch = install();
  if (mode === 'desktop') window.pilotdeckDesktop = { platform: 'darwin' } as typeof window.pilotdeckDesktop;
  const view = render(<ComputerUseSections />);
  await waitFor(() => expect(view.getByRole('switch').hasAttribute('disabled')).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('/api/computer-use/status', expect.objectContaining({ method: 'GET' }));
  expect(view.queryByText('computerUse.desktopRequired')).toBeNull();
  fireEvent.click(view.getByRole('switch'));
  await waitFor(() => expect(view.getByText('computerUse.phases.needs-permissions')).toBeTruthy());
  expect(fetch).toHaveBeenCalledWith('/api/computer-use/enabled', expect.objectContaining({ method: 'PUT', body: '{"enabled":true}' }));
  fireEvent.click(view.getByText('computerUse.stop'));
  await waitFor(() => expect(view.getByRole('switch').getAttribute('aria-checked')).toBe('false'));
  expect(fetch).toHaveBeenLastCalledWith('/api/computer-use/enabled', expect.objectContaining({ body: '{"enabled":false}' }));
});
it('failed enable leaves the previous state visible and displays the error', async () => {
  install(true); const view = render(<ComputerUseSections />);
  await waitFor(() => expect(view.getByRole('switch').hasAttribute('disabled')).toBe(false));
  fireEvent.click(view.getByRole('switch'));
  await waitFor(() => expect(view.getByRole('alert').textContent).toBe('failed to save'));
  expect(view.getByRole('switch').getAttribute('aria-checked')).toBe('false');
});
it('permission buttons explicitly request the selected grant through HTTP', async () => {
  const fetch = install(); const view = render(<ComputerUseSections />);
  await waitFor(() => expect(view.getAllByText('computerUse.openPermissions')).toHaveLength(2));
  fireEvent.click(view.getAllByText('computerUse.openPermissions')[1]);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/computer-use/permissions', expect.objectContaining({ method: 'POST', body: '{"permission":"screenRecording"}' })));
});
it('shows a status request failure without enabling controls', async () => {
  const fetch = install(); fetch.mockRejectedValueOnce(new Error('backend unavailable'));
  const view = render(<ComputerUseSections />);
  await waitFor(() => expect(view.getByRole('alert').textContent).toBe('backend unavailable'));
});
it.each(['browser', 'desktop'])('%s offers the permission-owner path and reveals it without starting permission requests', async mode => {
  const permissionAppPath = mode === 'desktop' ? '/Applications/PilotDeck.app' : '/environment/resources/cua-driver/PilotDeckComputerUse.app';
  if (mode === 'desktop') window.pilotdeckDesktop = { platform: 'darwin' } as typeof window.pilotdeckDesktop;
  const fetch = install(false, { ...disabled, permissionAppPath });
  const view = render(<ComputerUseSections />);
  await waitFor(() => expect(view.getByLabelText('computerUse.permissionAppPath').getAttribute('value')).toBe(permissionAppPath));
  expect(view.getByText('computerUse.permissionFallbackTitle').closest('details')?.open).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByText('computerUse.revealPermissionApp'));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/computer-use/permission-app/reveal', expect.objectContaining({method: 'POST'})));
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/permissions') || url.endsWith('/enabled'))).toBe(false);
});
it('copies the actual host path and keeps a selectable fallback on clipboard failure', async () => {
  const permissionAppPath = '/environment with spaces/PilotDeckComputerUse.app';
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  install(false, { ...disabled, permissionAppPath });
  const view = render(<ComputerUseSections />);
  await waitFor(() => expect(view.getByText('computerUse.copyPermissionPath')).toBeTruthy());
  fireEvent.click(view.getByText('computerUse.copyPermissionPath'));
  await waitFor(() => expect(view.getByText('computerUse.permissionPathCopied')).toBeTruthy());
  expect(copy).toHaveBeenCalledWith(permissionAppPath);
  copy.mockRejectedValueOnce(new Error('clipboard denied'));
  fireEvent.click(view.getByText('computerUse.copyPermissionPath'));
  await waitFor(() => expect(view.getByRole('alert').textContent).toBe('computerUse.copyPathFailed'));
  expect(view.getByLabelText('computerUse.permissionAppPath').hasAttribute('readonly')).toBe(true);
});
it.each(['win32', 'linux'])('does not expose the macOS permission fallback on %s', async platform => {
  install(false, { ...disabled, platform, permissions: undefined, permissionAppPath: '/unused/PilotDeck.app' });
  const view = render(<ComputerUseSections />);
  await waitFor(() => expect(view.getByRole('switch').hasAttribute('disabled')).toBe(false));
  expect(view.queryByText('computerUse.permissionFallbackTitle')).toBeNull();
});
