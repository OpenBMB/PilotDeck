// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NotificationsSection from './NotificationsSection';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); window.pilotdeckDesktop = undefined; vi.unstubAllGlobals(); localStorage.clear(); });
it('requests permission only on enable, handles denial, and hides desktop-only badge controls', async () => {
  const request = vi.fn(async () => 'denied');
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: request });
  render(<NotificationsSection />);
  const enabled = screen.getByRole('switch', { name: 'systemNotifications.enabled' });
  const sound = screen.getByRole('switch', { name: 'systemNotifications.sound' });
  expect(screen.queryByRole('switch', { name: 'systemNotifications.badge' })).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(sound.hasAttribute('disabled')).toBe(true);

  fireEvent.click(enabled);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(enabled.getAttribute('aria-checked')).toBe('false');
  request.mockResolvedValueOnce('granted');
  await waitFor(() => expect(enabled.hasAttribute('disabled')).toBe(false));
  fireEvent.click(enabled);
  await waitFor(() => expect(enabled.getAttribute('aria-checked')).toBe('true'));
  expect(sound.hasAttribute('disabled')).toBe(false);
  fireEvent.click(enabled);
  await waitFor(() => expect(enabled.getAttribute('aria-checked')).toBe('false'));

  fireEvent.click(screen.getByRole('button', { name: 'systemNotifications.showHelp' }));
  await screen.findByText('systemNotifications.browserHelp');
  expect(screen.queryByRole('button', { name: /test notification/i })).toBeNull();
});
it('retains the independent badge setting in desktop clients', async () => {
  window.pilotdeckDesktop = { platform: 'win32', getNotificationStatus: async () => ({ supported: true, permission: 'unknown',
    preferences: { enabled: false, sound: true, badge: true, preview: true } }),
    setNotificationPreferences: async value => value,
  } as NonNullable<Window['pilotdeckDesktop']>;
  render(<NotificationsSection />);
  const badge = await screen.findByRole('switch', { name: 'systemNotifications.badge' });
  await waitFor(() => expect(badge.getAttribute('aria-checked')).toBe('true'));
  expect(badge.hasAttribute('disabled')).toBe(false);
});
