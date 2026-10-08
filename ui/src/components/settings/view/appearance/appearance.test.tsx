// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppearanceSettings from './index';
import { ThemeProvider } from '../../../../contexts/ThemeContext';
import { LIGHT_APPEARANCE_KEY, normalizeLightAppearance } from '../../../../lib/lightAppearance';
import { saveBackgroundImage, deleteBackgroundImage, loadBackgroundImage } from '../../../../lib/appearanceImages';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../lib/appearanceImages', () => ({ saveBackgroundImage: vi.fn(), deleteBackgroundImage: vi.fn(async () => {}), loadBackgroundImage: vi.fn(async () => 'data:image/webp;base64,test') }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  localStorage.clear();
  window.pilotdeckDesktop = undefined;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const mount = () => render(<ThemeProvider><AppearanceSettings /></ThemeProvider>);
const choosePalette = (value: string) => fireEvent.click(screen.getByRole('button', { name: `lightAppearance.preset.${value}` }));
const saved = () => JSON.parse(localStorage.getItem(LIGHT_APPEARANCE_KEY) || 'null');
const IMAGE_ID = '12345678-1234-1234-1234-123456789012.png';
const seedImage = (value: Record<string, unknown> = {}) => localStorage.setItem(LIGHT_APPEARANCE_KEY, JSON.stringify(normalizeLightAppearance({ ...value, background: { type: 'image', imageId: IMAGE_ID } })));
it('saves presets, keeps custom colors and restores them after switching back', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'lightAppearance.accent' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'lightAppearance.accent HEX' }), { target: { value: '#126d71' } });
  await waitFor(() => expect(saved()?.custom.accent).toBe('#126d71'));
  choosePalette('rose');
  await waitFor(() => expect(saved()?.preset).toBe('rose'));
  choosePalette('custom');
  expect((screen.getByRole('textbox', { name: 'lightAppearance.accent HEX' }) as HTMLInputElement).value).toBe('#126D71');
});
it('offers only solid and image backgrounds and keeps the solid look until an image is chosen', async () => {
  mount();
  expect(screen.queryByRole('button', { name: 'lightAppearance.gradient' })).toBe(null);
  expect(screen.getByRole('button', { name: 'lightAppearance.solid' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByText('lightAppearance.panelAdjustments')).toBe(null);
  fireEvent.click(screen.getByRole('button', { name: 'lightAppearance.image' }));
  await waitFor(() => expect(saved()?.background.type).toBe('image'));
  expect(screen.getByText('lightAppearance.imageEmptyHint')).toBeTruthy();
  expect(screen.queryByRole('slider', { name: 'lightAppearance.blur' })).toBe(null);
  expect(screen.queryByText('lightAppearance.panelAdjustments')).toBe(null);
  // Without an image the original default theme stays untouched (no white-out).
  expect(document.documentElement.hasAttribute('data-light-appearance')).toBe(false);
  choosePalette('rose');
  await waitFor(() => expect(document.documentElement.getAttribute('data-light-background')).toBe('solid'));
  expect(document.getElementById('pd-light-appearance')?.textContent).toContain('--pd-content-fill:#ffffff');
  fireEvent.click(screen.getByRole('button', { name: 'lightAppearance.reset' }));
  await waitFor(() => expect(saved()).toEqual(normalizeLightAppearance()));
});
it('falls back to the solid background when the saved image is missing', async () => {
  vi.mocked(loadBackgroundImage).mockRejectedValueOnce(new Error('missing'));
  seedImage({ preset: 'rose' });
  mount();
  await waitFor(() => expect(screen.getByText('lightAppearance.imageMissing')).toBeTruthy());
  expect(document.documentElement.getAttribute('data-light-background')).toBe('solid');
  expect(document.getElementById('pd-light-appearance')?.textContent).toContain('--pd-wallpaper:none');
  expect(saved()?.background.imageId).toBe(IMAGE_ID);
  expect(screen.queryByText('lightAppearance.panelAdjustments')).toBe(null);
});
it('controls the wallpaper with one interface transparency slider', async () => {
  seedImage();
  mount();
  expect(screen.queryByRole('slider', { name: 'lightAppearance.intensity' })).toBe(null);
  expect(screen.queryByText('lightAppearance.panelAdjustments')).toBe(null);
  expect(screen.getByRole('slider', { name: 'lightAppearance.blur' })).toBeTruthy();
  const slider = screen.getByRole('slider', { name: 'lightAppearance.transparency' });
  expect(slider.getAttribute('min')).toBe('5');
  expect(slider.getAttribute('max')).toBe('40');
  fireEvent.change(slider, { target: { value: '40' } });
  await waitFor(() => expect(saved()?.transparency).toBe(40));
  await waitFor(() => expect(document.getElementById('pd-light-appearance')?.textContent).toContain('--pd-panel-alpha:60%'));
  expect(document.getElementById('pd-light-appearance')?.textContent).toContain('--pd-content-alpha:65%');
  cleanup(); mount();
  expect(screen.getByRole('slider', { name: 'lightAppearance.transparency' }).getAttribute('value')).toBe('40');
  fireEvent.click(screen.getByText('lightAppearance.imageAdjustments'));
  fireEvent.click(screen.getByRole('button', { name: 'lightAppearance.resetImageEffects' }));
  await waitFor(() => expect(saved()?.transparency).toBe(15));
});
it('keeps dark mode untouched, then restores the saved light palette', async () => {
  localStorage.setItem('themeMode', 'dark');
  localStorage.setItem(LIGHT_APPEARANCE_KEY, JSON.stringify(normalizeLightAppearance({ preset: 'mint' })));
  mount();
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(document.documentElement.hasAttribute('data-light-appearance')).toBe(false);
  expect(screen.getByText('lightAppearance.lightOnly')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'lightAppearance.editLight' }));
  await waitFor(() => expect(document.documentElement.hasAttribute('data-light-appearance')).toBe(true));
  expect(screen.getByRole('button', { name: 'lightAppearance.preset.mint' }).getAttribute('aria-pressed')).toBe('true');
});
it('rolls back a failed storage write and reports the failure', async () => {
  mount();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  choosePalette('blue');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('lightAppearance.saveFailed'));
  expect(screen.getByRole('button', { name: 'lightAppearance.preset.default' }).getAttribute('aria-pressed')).toBe('true');
});
it('reveals an uploaded image without another switch, replaces it and removes the old managed asset', async () => {
  const first = '12345678-1234-1234-1234-123456789012.webp';
  const second = '22345678-1234-1234-1234-123456789012.webp';
  vi.mocked(saveBackgroundImage).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  localStorage.setItem(LIGHT_APPEARANCE_KEY, JSON.stringify({ panelOpacity: 100 }));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'lightAppearance.image' }));
  fireEvent.change(screen.getByLabelText('lightAppearance.chooseImage'), { target: { files: [new File(['test'], 'test.png', { type: 'image/png' })] } });
  await waitFor(() => expect(saved()?.background.imageId).toBe(first));
  expect(saved()?.transparency).toBe(15);
  await waitFor(() => expect(document.getElementById('pd-light-appearance')?.textContent).toContain('--pd-content-alpha:90%'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'lightAppearance.replaceImage' }).hasAttribute('disabled')).toBe(false));
  fireEvent.change(screen.getByLabelText('lightAppearance.chooseImage'), { target: { files: [new File(['test2'], 'test2.png', { type: 'image/png' })] } });
  await waitFor(() => expect(saved()?.background.imageId).toBe(second));
  expect(deleteBackgroundImage).toHaveBeenCalledWith(first);
  cleanup(); mount();
  await waitFor(() => expect(document.getElementById('pd-light-appearance')?.textContent).toContain('--pd-panel-alpha:85%'));
  fireEvent.click(screen.getByRole('button', { name: 'lightAppearance.removeImage' }));
  await waitFor(() => expect(saved()?.background.imageId).toBe(null));
});
it('follows system changes without losing the selected light appearance', async () => {
  let change: (event: { matches: boolean }) => void = () => {};
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: (_: string, listener: typeof change) => { change = listener; }, removeEventListener: vi.fn() });
  localStorage.setItem(LIGHT_APPEARANCE_KEY, JSON.stringify(normalizeLightAppearance({ preset: 'blue' })));
  mount();
  act(() => change({ matches: true }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(document.documentElement.hasAttribute('data-light-appearance')).toBe(false);
  act(() => change({ matches: false }));
  expect(document.documentElement.hasAttribute('data-light-appearance')).toBe(true);
  expect(screen.getByRole('button', { name: 'lightAppearance.preset.blue' }).getAttribute('aria-pressed')).toBe('true');
});
it('serializes desktop edits and keeps a newer successful edit after an earlier failure', async () => {
  let failFirst: (reason?: unknown) => void = () => {};
  const persist = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject; })).mockResolvedValue(undefined);
  window.pilotdeckDesktop = { getAppearance: () => ({ language: 'en', themeMode: 'light' }), setAppearance: persist } as unknown as NonNullable<Window['pilotdeckDesktop']>;
  mount();
  choosePalette('blue');
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
  choosePalette('rose');
  expect(persist).toHaveBeenCalledTimes(1);
  await act(async () => failFirst(new Error('disk full')));
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
  expect(persist.mock.calls[1][0].lightAppearance.preset).toBe('rose');
  expect(screen.queryByRole('alert')).toBe(null);
  expect(screen.getByRole('button', { name: 'lightAppearance.preset.rose' }).getAttribute('aria-pressed')).toBe('true');
});

it('saves image effects and reduced motion, then restores them on remount', async () => {
  seedImage();
  mount();
  fireEvent.click(screen.getByText('lightAppearance.imageAdjustments'));
  fireEvent.change(screen.getByRole('slider', { name: 'lightAppearance.brightness' }), { target: { value: '125' } });
  await waitFor(() => expect(saved()?.background.brightness).toBe(125));
  fireEvent.click(screen.getByText('lightAppearance.advanced'));
  fireEvent.change(screen.getByLabelText('lightAppearance.reducedMotion'), { target: { value: 'on' } });
  await waitFor(() => expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true));
  cleanup(); mount();
  expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true);
  fireEvent.click(screen.getByText('lightAppearance.imageAdjustments'));
  expect((screen.getByRole('slider', { name: 'lightAppearance.brightness' }) as HTMLInputElement).value).toBe('125');
});

it('preserves the current image and settings when image replacement fails', async () => {
  const id = '12345678-1234-1234-1234-123456789012.png';
  localStorage.setItem(LIGHT_APPEARANCE_KEY, JSON.stringify(normalizeLightAppearance({ background: { type: 'image', imageId: id } })));
  vi.mocked(saveBackgroundImage).mockRejectedValueOnce(new Error('disk full'));
  mount();
  fireEvent.change(screen.getByLabelText('lightAppearance.chooseImage'), { target: { files: [new File(['broken'], 'test.png', { type: 'image/png' })] } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('lightAppearance.imageSaveFailed'));
  expect(saved()?.background.imageId).toBe(id);
});

it('rolls back an advanced preference when persistence fails', async () => {
  mount();
  fireEvent.click(screen.getByText('lightAppearance.advanced'));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  fireEvent.change(screen.getByLabelText('lightAppearance.reducedMotion'), { target: { value: 'on' } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('lightAppearance.saveFailed'));
  expect((screen.getByLabelText('lightAppearance.reducedMotion') as HTMLSelectElement).value).toBe('system');
  expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false);
});

it('opens custom colors directly, validates HEX and returns focus on Escape', async () => {
  mount();
  choosePalette('custom');
  await waitFor(() => expect(saved()?.preset).toBe('custom'));
  const input = screen.getByRole('textbox', { name: 'lightAppearance.accent HEX' });
  const previous = saved().custom.accent;
  fireEvent.change(input, { target: { value: '#GGGGGG' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('alert').textContent).toBe('lightAppearance.invalidColor');
  expect(saved().custom.accent).toBe(previous);
  fireEvent.change(input, { target: { value: '123' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(saved().custom.accent).toBe('#112233'));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBe(null);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'lightAppearance.accent' }));
});

it('supports keyboard color adjustment and closes when clicking outside', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'lightAppearance.accent' }));
  fireEvent.keyDown(screen.getByRole('button', { name: 'lightAppearance.colorPlane' }), { key: 'ArrowLeft' });
  await waitFor(() => expect(saved()?.preset).toBe('custom'));
  const changed = saved().custom.accent;
  fireEvent.change(screen.getByRole('slider', { name: 'lightAppearance.hue' }), { target: { value: '120' } });
  await waitFor(() => expect(saved().custom.accent).not.toBe(changed));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).toBe(null);
});
