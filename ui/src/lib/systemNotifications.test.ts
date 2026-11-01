// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clearWebNotificationBadge } from './systemNotifications';

afterEach(() => { window.pilotdeckDesktop = undefined; vi.restoreAllMocks(); document.title = 'PilotDeck'; });
it('removes legacy web title counts and clears PWA badges without publishing a new count', async () => {
  document.title = '(9) PilotDeck';
  const clear = vi.fn(async () => {});
  const set = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clearAppBadge', { value: clear, configurable: true });
  Object.defineProperty(navigator, 'setAppBadge', { value: set, configurable: true });
  await clearWebNotificationBadge();
  expect(document.title).toBe('PilotDeck');
  expect(clear).toHaveBeenCalledOnce();
  expect(set).not.toHaveBeenCalled();
  delete (navigator as any).clearAppBadge;
  delete (navigator as any).setAppBadge;
  await expect(clearWebNotificationBadge()).resolves.toBeUndefined();
});
it('leaves desktop badge ownership with the main process', async () => {
  window.pilotdeckDesktop = { platform: 'linux' } as NonNullable<Window['pilotdeckDesktop']>;
  const clear = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clearAppBadge', { value: clear, configurable: true });
  await clearWebNotificationBadge();
  expect(clear).not.toHaveBeenCalled();
  delete (navigator as any).clearAppBadge;
});
