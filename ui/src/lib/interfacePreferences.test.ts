// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { normalizeInterfacePreferences } from './interfacePreferences';
import { applyMemoryAppearance } from './memoryAppearance';
import { normalizeLightAppearance } from './lightAppearance';

it('migrates performance preferences without disabling acceleration by accident', () => {
  expect(normalizeInterfacePreferences()).toEqual({ hardwareAcceleration: true, reducedMotion: 'system' });
  expect(normalizeInterfacePreferences({ hardwareAcceleration: 'false', reducedMotion: 'bad' })).toEqual(normalizeInterfacePreferences());
  expect(normalizeInterfacePreferences({ hardwareAcceleration: false, reducedMotion: 'on' })).toEqual({ hardwareAcceleration: false, reducedMotion: 'on' });
});
it('maps only interface tokens in memory and removes light overrides in dark mode', () => {
  const doc = document.implementation.createHTMLDocument('Memory');
  const palette = normalizeLightAppearance({ preset: 'mint' });
  applyMemoryAppearance(doc, palette, false, true);
  const style = doc.getElementById('pilotdeck-memory-appearance')!;
  expect(style.textContent).toContain('--accent:');
  expect(style.textContent).not.toContain('--status-project');
  expect(style.textContent).not.toContain('--danger');
  expect(style.textContent).toContain('animation-duration');
  applyMemoryAppearance(doc, palette, true, false);
  expect(style.textContent).toBe('');
  applyMemoryAppearance(doc, normalizeLightAppearance(), false, false);
  expect(style.textContent).toBe('');
});
it('clamps image adjustments and migrates earlier configurations', () => {
  const v = normalizeLightAppearance({ background: { brightness: 900, saturation: -10, positionX: NaN, positionY: 101 } });
  expect(v.background).toMatchObject({ brightness: 150, saturation: 0, positionX: 50, positionY: 100 });
  expect(normalizeLightAppearance().background).toMatchObject({ brightness: 100, saturation: 100, positionX: 50, positionY: 50 });
});
