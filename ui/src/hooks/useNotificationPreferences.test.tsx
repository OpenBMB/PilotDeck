// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { window.pilotdeckDesktop = undefined; localStorage.clear(); vi.resetModules(); });
it('new desktop installs start enabled before native settings load', async () => {
  window.pilotdeckDesktop = { platform: 'win32' } as any;
  const { getNotificationPreferences } = await import('./useNotificationPreferences');
  expect(getNotificationPreferences().enabled).toBe(true);
});
it('preserves explicit desktop opt-out and leaves browser permission opt-in intact', async () => {
  window.pilotdeckDesktop = { platform: 'win32' } as any;
  localStorage.setItem('pilotdeck-notifications-v1', JSON.stringify({ enabled: false }));
  expect((await import('./useNotificationPreferences')).getNotificationPreferences().enabled).toBe(false);
  vi.resetModules(); localStorage.clear(); window.pilotdeckDesktop = undefined;
  expect((await import('./useNotificationPreferences')).getNotificationPreferences().enabled).toBe(false);
});
