// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { contrast, DEFAULT_TRANSPARENCY, deriveLightBackgrounds, deriveLightColors, LIGHT_PRESETS, MAX_TRANSPARENCY, MIN_TRANSPARENCY, panelOpacities, normalizeLightAppearance, selectedPalette, isImageId, mixColor, hasBackgroundImage, isCustomizedLightAppearance, withoutMissingImage } from './lightAppearance';
import { applyLightAppearance } from './appearanceRuntime';

const IMAGE = { type: 'image', imageId: '12345678-1234-1234-1234-123456789012.png' };
describe('light appearance', () => {
  it('migrates missing settings and rejects malformed colors, paths and ranges', () => {
    expect(normalizeLightAppearance().preset).toBe('default');
    const result = normalizeLightAppearance({ preset: '__proto__', custom: { accent: 'red;display:none' }, transparency: 200, background: { imageId: '../../secret', blur: 500 } });
    expect(result.preset).toBe('default');
    expect(result.custom.accent).toBe(LIGHT_PRESETS.default.accent);
    expect(result.transparency).toBe(MAX_TRANSPARENCY);
    expect(result.version).toBe(2);
    expect(result.background).toMatchObject({ imageId: null, blur: 30 });
    expect(result.background).not.toHaveProperty('intensity');
    expect(normalizeLightAppearance({ transparency: NaN }).transparency).toBe(DEFAULT_TRANSPARENCY);
    expect(normalizeLightAppearance({ transparency: 0 }).transparency).toBe(MIN_TRANSPARENCY);
    expect(isImageId('12345678-1234-1234-1234-123456789012.webp')).toBe(true);
  });
  it('preserves the custom palette while selecting other presets', () => {
    const custom = { accent: '#ac1256', background: '#fbf2ed' };
    const v = normalizeLightAppearance({ preset: 'blue', custom });
    expect(selectedPalette(v)).toEqual(LIGHT_PRESETS.blue);
    expect(selectedPalette({ ...v, preset: 'custom' })).toEqual(custom);
  });
  it.each([...Object.keys(LIGHT_PRESETS), 'custom'])('provides readable UI colors for %s', preset => {
    const custom = { accent: '#ffffee', background: '#000000' };
    const solid = deriveLightColors(normalizeLightAppearance({ preset, custom, transparency: MAX_TRANSPARENCY }));
    expect(solid.surface).toBe('#ffffff');
    expect(contrast(solid.accent, solid.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(solid.ink, solid.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(solid.muted, solid.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(solid.sidebarInk, solid.sidebar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(solid.sidebarAccent, solid.sidebar)).toBeGreaterThanOrEqual(4.5);
    const c = deriveLightColors(normalizeLightAppearance({ preset, custom, transparency: MAX_TRANSPARENCY, background: IMAGE }));
    const darkestComposite = mixColor(c.sidebar, '#000000', .4);
    expect(contrast(c.sidebarInk, darkestComposite)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.sidebarAccent, darkestComposite)).toBeGreaterThanOrEqual(4.5);
  });
  it.each([...Object.keys(LIGHT_PRESETS), 'custom'])('keeps reading surfaces white and only tints the chrome for solid %s', preset => {
    const v = normalizeLightAppearance({ preset, custom: { accent: '#ac1256', background: '#b9dfce' }, transparency: MAX_TRANSPARENCY });
    const c = deriveLightColors(v);
    const fills = deriveLightBackgrounds(v, c);
    expect(fills.content).toBe('#ffffff');
    expect(fills.sidebar).toBe(c.sidebar);
    expect(fills.backdrop).toBe(selectedPalette(v).background);
    applyLightAppearance(v, false);
    const css = document.getElementById('pd-light-appearance')!.textContent!;
    if (preset === 'default') { expect(css).toBe(''); return; }
    expect(document.documentElement.getAttribute('data-light-background')).toBe('solid');
    for (const token of ['background', 'card', 'popover']) expect(css).toContain(`--${token}:0 0% 100%`);
    for (const token of ['muted', 'secondary', 'accent', 'border', 'input']) expect(css).not.toMatch(new RegExp(`--${token}:`));
  });
  it('removes all custom variables and image layers in dark mode and restores light', () => {
    const v = normalizeLightAppearance({ preset: 'rose', background: IMAGE });
    applyLightAppearance(v, false, 'blob:sample');
    expect(document.documentElement.hasAttribute('data-light-appearance')).toBe(true);
    expect(document.documentElement.getAttribute('data-light-background')).toBe('image');
    expect(document.getElementById('pd-light-appearance')!.textContent).toContain('blob:sample');
    applyLightAppearance(v, true, 'blob:sample');
    expect(document.documentElement.hasAttribute('data-light-appearance')).toBe(false);
    expect(document.documentElement.hasAttribute('data-light-background')).toBe(false);
    expect(document.getElementById('pd-light-appearance')!.textContent).toBe('');
    applyLightAppearance(v, false);
    expect(document.documentElement.hasAttribute('data-light-appearance')).toBe(true);
    applyLightAppearance(normalizeLightAppearance(), false);
    expect(document.getElementById('pd-light-appearance')!.textContent).toBe('');
    expect(document.documentElement.hasAttribute('data-light-background')).toBe(false);
  });
  it('shows backgrounds automatically and migrates previously opaque panels', () => {
    const image = normalizeLightAppearance({ panelOpacity: 100, background: IMAGE });
    expect(image.transparency).toBe(DEFAULT_TRANSPARENCY);
    expect(image).not.toHaveProperty('panelOpacity');
    expect(image).not.toHaveProperty('contentOpacity');
    expect(normalizeLightAppearance().transparency).toBe(DEFAULT_TRANSPARENCY);
    expect(panelOpacities(image)).toEqual({ sidebar: 85, content: 90 });
    applyLightAppearance(image, false, 'blob:previously-hidden');
    const style = document.getElementById('pd-light-appearance')!;
    expect(style.textContent).toContain('--pd-wallpaper:url("blob:previously-hidden")');
    expect(style.textContent).toContain('--pd-panel-alpha:85%');
    expect(style.textContent).toContain('--pd-content-alpha:90%');
    expect(style.textContent).not.toContain('--pd-image-opacity');
    expect(deriveLightBackgrounds(image).content).toContain('90%, transparent');
    applyLightAppearance(image, true);
    expect(style.textContent).toBe('');
    applyLightAppearance(normalizeLightAppearance({ panelOpacity: 100 }), false);
    expect(style.textContent).toBe('');
  });
  it('renders the solid background until an image is chosen or when it is missing', () => {
    const empty = normalizeLightAppearance({ background: { type: 'image' } });
    expect(hasBackgroundImage(empty)).toBe(false);
    expect(isCustomizedLightAppearance(empty)).toBe(false);
    applyLightAppearance(empty, false);
    expect(document.documentElement.hasAttribute('data-light-appearance')).toBe(false);
    const rose = normalizeLightAppearance({ preset: 'rose', background: { type: 'image' } });
    applyLightAppearance(rose, false);
    expect(document.documentElement.getAttribute('data-light-background')).toBe('solid');
    expect(deriveLightBackgrounds(rose).content).toBe('#ffffff');
    const saved = normalizeLightAppearance({ preset: 'rose', background: IMAGE });
    expect(hasBackgroundImage(saved)).toBe(true);
    expect(withoutMissingImage(saved, false)).toBe(saved);
    const missing = withoutMissingImage(saved, true);
    expect(hasBackgroundImage(missing)).toBe(false);
    expect(saved.background.imageId).toBe(IMAGE.imageId);
    applyLightAppearance(missing, false, 'blob:stale');
    expect(document.documentElement.getAttribute('data-light-background')).toBe('solid');
    expect(document.getElementById('pd-light-appearance')!.textContent).toContain('--pd-wallpaper:none');
  });
  it('folds the removed gradient option into the solid background', () => {
    const legacy = normalizeLightAppearance({ preset: 'custom', custom: { background: '#b9dfce' }, background: { type: 'gradient', gradientEnd: '#e9bee4', angle: 45 } });
    expect(legacy.background.type).toBe('solid');
    expect(legacy.background).not.toHaveProperty('gradientEnd');
    expect(legacy.background).not.toHaveProperty('angle');
    expect(selectedPalette(legacy).background).toBe('#b9dfce');
    expect(deriveLightBackgrounds(legacy).backdrop).toBe('#b9dfce');
    applyLightAppearance(legacy, false);
    expect(document.documentElement.getAttribute('data-light-background')).toBe('solid');
    expect(document.getElementById('pd-light-appearance')!.textContent).not.toContain('linear-gradient');
    applyLightAppearance(legacy, true);
    expect(document.getElementById('pd-light-appearance')!.textContent).toBe('');
  });
  it('folds image intensity and both panel opacities into one transparency', () => {
    // visible image = intensity × (1 − sidebar opacity)
    expect(normalizeLightAppearance({ panelOpacity: 60, background: { intensity: 100 } }).transparency).toBe(40);
    expect(normalizeLightAppearance({ panelOpacity: 70, background: { intensity: 50 } }).transparency).toBe(15);
    expect(normalizeLightAppearance({ panelOpacity: 95, contentOpacity: 60, background: { intensity: 65 } }).transparency).toBe(MIN_TRANSPARENCY);
    expect(normalizeLightAppearance({ panelOpacity: 85, contentOpacity: 90, background: { intensity: 65 } }).transparency).toBe(DEFAULT_TRANSPARENCY);
    expect(normalizeLightAppearance({ panelOpacity: 60, background: { intensity: 0 } }).transparency).toBe(MIN_TRANSPARENCY);
    const migrated = normalizeLightAppearance({ version: 1, panelOpacity: 60, contentOpacity: 75, background: { ...IMAGE, intensity: 100, blur: 4 } });
    expect(migrated).toEqual(normalizeLightAppearance(migrated));
    expect(migrated.background.blur).toBe(4);
    expect(panelOpacities(normalizeLightAppearance({ transparency: MIN_TRANSPARENCY }))).toEqual({ sidebar: 95, content: 95 });
    expect(panelOpacities(normalizeLightAppearance({ transparency: MAX_TRANSPARENCY }))).toEqual({ sidebar: 60, content: 65 });
    const value = normalizeLightAppearance({ transparency: 30, background: IMAGE });
    expect(deriveLightBackgrounds(value).sidebar).toContain('70%, transparent');
    expect(deriveLightBackgrounds(value).content).toContain('75%, transparent');
    applyLightAppearance(value, false);
    expect(document.getElementById('pd-light-appearance')!.textContent).toContain('--pd-content-alpha:75%');
    applyLightAppearance(value, true);
    expect(document.getElementById('pd-light-appearance')!.textContent).toBe('');
  });
  it.each(['#000000', '#ffffff', '#ff0000', '#0000ff', '#00ff00'])('keeps panel labels readable at opacity limits with %s', background => {
    for (const transparency of [MIN_TRANSPARENCY, DEFAULT_TRANSPARENCY, 25, MAX_TRANSPARENCY]) {
      const v = normalizeLightAppearance({ preset: 'custom', custom: { background }, transparency, background: IMAGE });
      const c = deriveLightColors(v);
      const opacity = panelOpacities(v);
      expect(contrast(c.sidebarInk, mixColor(c.sidebar, '#000000', 1 - opacity.sidebar / 100))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.ink, mixColor(c.surface, '#000000', 1 - opacity.content / 100))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.muted, mixColor(c.surface, '#000000', 1 - opacity.content / 100))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
