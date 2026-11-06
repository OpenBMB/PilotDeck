// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { contrast, deriveAppearanceColors, LIGHT_PRESETS, normalizeLightAppearance, selectedPalette } from './lightAppearance';
import { applyLightAppearance } from './appearanceRuntime';

it('offers six presets without discarding a retired palette or independently saved custom colors', () => {
  expect(Object.keys(LIGHT_PRESETS)).toHaveLength(6);
  const custom = { accent: '#123456', background: '#abcdef' };
  const old = normalizeLightAppearance({ preset: 'lavender', custom, background: { blur: 12 } });
  expect(selectedPalette(old)).toEqual({ accent: '#72618f', background: '#eeebf3' });
  expect(old.custom).toEqual(custom);
  expect(normalizeLightAppearance(old)).toEqual(old);
});

for (const dark of [false, true]) {
  it.each([...Object.keys(LIGHT_PRESETS), 'custom', 'lavender'])(`provides distinct states and readable text in ${dark ? 'dark' : 'light'} %s`, preset => {
    const value = normalizeLightAppearance({ preset });
    const c = deriveAppearanceColors(value, dark);
    for (const bg of [c.surface, c.elevated, ...c.sidebarGradient.match(/#[\da-f]{6}/gi)!]) {
      expect(contrast(c.ink, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.muted, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(c.strong, c.selected)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', c.accentHover)).toBeGreaterThanOrEqual(4.5);
    expect(new Set([c.soft, c.hover, c.selected]).size).toBe(3);
    if (dark) expect(contrast('#000000', c.background)).toBeGreaterThan(1.25);
  });
}

it.each(['#000000', '#ffffff', '#ffff00', '#ff0000', '#00ff00', '#0000ff'])('keeps custom %s readable in either mode', accent => {
  for (const dark of [false, true]) {
    const c = deriveAppearanceColors(normalizeLightAppearance({ preset: 'custom', custom: { accent } }), dark);
    expect(contrast('#ffffff', c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.strong, c.selected)).toBeGreaterThanOrEqual(4.5);
  }
});

it('restores the original default light theme after applying each dark palette', () => {
  for (const preset of Object.keys(LIGHT_PRESETS)) {
    applyLightAppearance(normalizeLightAppearance({ preset }), true);
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(true);
    expect(document.getElementById('pd-light-appearance')?.textContent).toContain('--pd-accent-12:');
    applyLightAppearance(normalizeLightAppearance(), false);
    expect(document.documentElement.hasAttribute('data-appearance')).toBe(false);
    expect(document.getElementById('pd-light-appearance')?.textContent).toBe('');
  }
});
