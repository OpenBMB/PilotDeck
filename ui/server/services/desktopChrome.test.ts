// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
const ipc = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  sendSync: vi.fn().mockReturnValue({ dark: true, fullscreen: false }),
}));
import { installWindowChrome } from '../../../apps/desktop/src/preloadChrome';
import { isRendererEditingShortcut, windowChromeOptions } from '../../../apps/desktop/src/windowChrome';

it('reserves only plain editing shortcuts for the renderer, leaving macOS fullscreen native', () => {
  const input = { key: 'f', meta: true, control: false, shift: false, alt: false, isComposing: false };
  expect(isRendererEditingShortcut('darwin', input)).toBe(true);
  expect(isRendererEditingShortcut('darwin', { ...input, key: 'B' })).toBe(true);
  expect(isRendererEditingShortcut('darwin', { ...input, control: true })).toBe(false);
  for (const flag of ['shift', 'alt', 'isComposing'] as const) {
    expect(isRendererEditingShortcut('darwin', { ...input, [flag]: true })).toBe(false);
  }
  expect(isRendererEditingShortcut('darwin', { ...input, meta: false, control: true })).toBe(false);
  expect(isRendererEditingShortcut('win32', { ...input, meta: false, control: true })).toBe(true);
  expect(isRendererEditingShortcut('win32', { ...input, control: true })).toBe(false);
});

it('uses transparent default Windows light chrome and preserves the other native palettes', () => {
  expect(windowChromeOptions('darwin', true)).toMatchObject({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, backgroundColor: '#0a0a0a' });
  expect(windowChromeOptions('win32', false)).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: 32, color: '#00000000', symbolColor: '#262626' } });
  expect(windowChromeOptions('win32', true)).toMatchObject({ titleBarOverlay: { color: '#171717', symbolColor: '#e5e5e5' } });
  expect(windowChromeOptions('linux', false)).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: 32, color: '#f4f4f5', symbolColor: '#262626' } });
  expect(windowChromeOptions('linux', true)).toMatchObject({ titleBarOverlay: { color: '#171717', symbolColor: '#e5e5e5' } });
});
it('Windows caption initializes its saved language, follows language/fullscreen changes and opens native menus', async () => {
  document.documentElement.lang = 'en';
  ipc.sendSync.mockImplementation(channel => channel === 'pilotdeck:get-appearance'
    ? { language: 'zh-CN' } : { dark: true, fullscreen: false });
  installWindowChrome('win32', ipc as any);
  window.dispatchEvent(new Event('DOMContentLoaded'));
  const host = document.getElementById('pilotdeck-window-caption')!;
  const button = host.shadowRoot!.querySelector('button')!;
  const buttons = [...host.shadowRoot!.querySelectorAll('button')];
  expect(buttons.map(button => button.textContent)).toEqual(['文件', '编辑', '查看', '前往', '帮助']);
  document.documentElement.lang = 'en';
  await Promise.resolve();
  expect(buttons.map(button => button.textContent)).toEqual(['File', 'Edit', 'View', 'Go', 'Help']);
  expect(document.documentElement.dataset.desktopPlatform).toBe('win32');
  expect(document.documentElement.hasAttribute('data-desktop-dark')).toBe(true);
  button.click(); button.click();
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
  expect(ipc.invoke).toHaveBeenLastCalledWith('pilotdeck:show-menu', expect.objectContaining({ id: 'menu-file', buttons: expect.any(Array) }));
  await Promise.resolve();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10' }));
  expect(ipc.invoke).toHaveBeenCalledTimes(2);
  expect(ipc.invoke).toHaveBeenLastCalledWith('pilotdeck:show-menu');
  await Promise.resolve();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', altKey: true }));
  expect(ipc.invoke).toHaveBeenLastCalledWith('pilotdeck:show-menu', expect.objectContaining({ id: 'menu-edit' }));
  await Promise.resolve();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true }));
  expect(ipc.invoke).toHaveBeenCalledTimes(3);
  // A second menu request must not wait for the first native popup to close.
  let closeFirst!: () => void;
  let closeSecond!: () => void;
  ipc.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { closeFirst = resolve; }));
  ipc.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { closeSecond = resolve; }));
  button.click();
  buttons[1].dispatchEvent(new MouseEvent('mouseenter'));
  expect(ipc.invoke).toHaveBeenLastCalledWith('pilotdeck:show-menu', expect.objectContaining({ id: 'menu-edit' }));
  closeFirst();
  await Promise.resolve();
  expect(buttons[1].getAttribute('aria-expanded')).toBe('true');
  const menuCallback = ipc.on.mock.calls.find(call => call[0] === 'pilotdeck:caption-menu')![1];
  menuCallback({}, 'menu-view');
  expect(buttons[2].getAttribute('aria-expanded')).toBe('true');
  expect(buttons[1].getAttribute('aria-expanded')).toBe('false');
  closeSecond();
  await Promise.resolve();
  expect(buttons[2].getAttribute('aria-expanded')).toBe('false');
  document.documentElement.lang = 'zh-CN';
  await Promise.resolve();
  expect(buttons.map(button => button.textContent)).toEqual(['文件', '编辑', '查看', '前往', '帮助']);
  button.focus();
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  expect(host.shadowRoot!.activeElement).toBe(buttons[1]);
  const callback = ipc.on.mock.calls.find(call => call[0] === 'pilotdeck:window-state')![1];
  callback({}, { dark: false, fullscreen: true });
  expect(host.hidden).toBe(true);
  expect(document.documentElement.hasAttribute('data-desktop-dark')).toBe(false);
  callback({}, { dark: false, fullscreen: false });
  expect(host.hidden).toBe(false);
});
