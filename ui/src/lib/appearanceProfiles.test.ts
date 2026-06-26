import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_PRESETS,
  createProfileFromPreset,
  hexToHslTriplet,
  hslTripletToHex,
  normalizeAppearanceStore,
  normalizeProfile,
  readAppearanceAssetFile,
} from './appearanceProfiles';

describe('appearanceProfiles', () => {
  it('creates editable copies from read-only presets', () => {
    const copy = createProfileFromPreset(APPEARANCE_PRESETS[1], 'Customer Blue');

    expect(copy.name).toBe('Customer Blue');
    expect(copy.readonly).toBe(false);
    expect(copy.id).not.toBe(APPEARANCE_PRESETS[1].id);
    expect(copy.theme.light.primary).toBe(APPEARANCE_PRESETS[1].theme.light.primary);
  });

  it('normalizes malformed stores without losing valid custom profiles', () => {
    const profile = createProfileFromPreset(APPEARANCE_PRESETS[2], 'Terminal Copy');
    const normalized = normalizeAppearanceStore({
      activeProfileId: profile.id,
      profiles: [
        profile,
        null,
        { name: 'missing id' },
      ],
    });

    expect(normalized.activeProfileId).toBe(profile.id);
    expect(normalized.profiles).toHaveLength(1);
    expect(normalized.profiles[0].name).toBe('Terminal Copy');
    expect(normalized.profiles[0].layout).toBe('compactTools');
  });

  it('normalizes unknown layout values to the balanced layout', () => {
    const normalized = normalizeProfile({
      id: 'custom',
      name: 'Custom',
      layout: 'wide-open' as never,
    });

    expect(normalized.layout).toBe('balanced');
  });

  it('falls back when the active profile id is missing', () => {
    const normalized = normalizeAppearanceStore({
      activeProfileId: 'missing-profile',
      profiles: [],
    });

    expect(normalized.activeProfileId).toBe(APPEARANCE_PRESETS[0].id);
  });

  it('round-trips common color inputs between hex and HSL triplets', () => {
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%');
    expect(hslTripletToHex('0 0% 100%')).toBe('#ffffff');
    expect(hexToHslTriplet('#000000')).toBe('0 0% 0%');
    expect(hslTripletToHex('0 0% 0%')).toBe('#000000');
  });

  it('reads uploaded appearance assets as data URLs', async () => {
    const file = new File(
      ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"></svg>'],
      'logo.svg',
      { type: 'image/svg+xml' },
    );

    await expect(readAppearanceAssetFile(file)).resolves.toMatch(/^data:image\/svg\+xml/);
  });

  it('rejects appearance assets above the configured size limit', async () => {
    const file = new File(['123456'], 'large.svg', { type: 'image/svg+xml' });

    await expect(readAppearanceAssetFile(file, 4)).rejects.toThrow('asset-too-large');
  });
});
