// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installDesktopFilePicker } from './desktopFilePicker';
let dispose = () => {};
afterEach(() => { dispose(); document.body.replaceChildren(); window.pilotdeckDesktop = undefined; vi.restoreAllMocks(); });
const input = (attributes = '') => { document.body.innerHTML = `<input type="file" ${attributes}>`; return document.querySelector('input')!; };
it('leaves browser file pickers and disabled inputs unchanged', () => {
  const el = input(); dispose = installDesktopFilePicker();
  const click = new MouseEvent('click', { bubbles: true, cancelable: true }); el.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
});
it('routes any file upload to the native bridge with its original filters and selection mode', async () => {
  const pick = vi.fn().mockResolvedValue('selected');
  window.pilotdeckDesktop = { pickFiles: pick } as unknown as NonNullable<Window['pilotdeckDesktop']>;
  const el = input('accept="image/png,image/jpeg,image/webp" multiple'); dispose = installDesktopFilePicker();
  const click = new MouseEvent('click', { bubbles: true, cancelable: true }); el.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(pick).toHaveBeenCalledWith(expect.objectContaining({ accept: el.accept, multiple: true, directory: false }));
  expect(el.hasAttribute('data-pilotdeck-file-picker')).toBe(true);
  await vi.waitFor(() => expect(el.hasAttribute('data-pilotdeck-file-picker')).toBe(false));
});
it('preserves folder uploads and prevents duplicate dialogs while one is open', async () => {
  let resolve!: (result: 'canceled') => void;
  const pick = vi.fn(() => new Promise<'canceled'>(done => { resolve = done; }));
  window.pilotdeckDesktop = { pickFiles: pick } as unknown as NonNullable<Window['pilotdeckDesktop']>;
  const el = input('webkitdirectory multiple'); dispose = installDesktopFilePicker();
  const cancel = vi.fn(); el.addEventListener('cancel', cancel);
  el.click(); el.click();
  expect(pick).toHaveBeenCalledTimes(1);
  expect(pick).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  resolve('canceled');
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
});
it('reports failure without leaving the picker locked', async () => {
  const pick = vi.fn().mockRejectedValueOnce(new Error('dialog')).mockResolvedValue('selected');
  window.pilotdeckDesktop = { pickFiles: pick } as unknown as NonNullable<Window['pilotdeckDesktop']>;
  const el = input(); dispose = installDesktopFilePicker();
  const toast = vi.fn(); window.addEventListener('pilotdeck:toast', toast, { once: true });
  el.click(); await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(el.hasAttribute('data-pilotdeck-file-picker')).toBe(false));
  el.click(); expect(pick).toHaveBeenCalledTimes(2);
});
it('respects disabled fieldsets and releases the delegated handler on disposal', () => {
  const pick = vi.fn().mockResolvedValue('selected');
  window.pilotdeckDesktop = { pickFiles: pick } as unknown as NonNullable<Window['pilotdeckDesktop']>;
  document.body.innerHTML = '<fieldset disabled><input type="file"></fieldset>';
  const el = document.querySelector('input')!; dispose = installDesktopFilePicker();
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(pick).not.toHaveBeenCalled();
  document.querySelector('fieldset')!.disabled = false;
  dispose(); el.click();
  expect(pick).not.toHaveBeenCalled();
});
