export type AppearancePalette = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  input: string;
  ring: string;
};

export type AppearanceTheme = {
  light: AppearancePalette;
  dark: AppearancePalette;
};

export type AppearanceFont = 'inter' | 'system' | 'mono';
export type AppearanceDensity = 'comfortable' | 'compact';
export type AppearanceLayout = 'balanced' | 'compactTools' | 'spacious';

export type AppearanceProfile = {
  id: string;
  name: string;
  brandName: string;
  tagline: string;
  logoLight: string;
  logoDark: string;
  favicon: string;
  font: AppearanceFont;
  density: AppearanceDensity;
  layout: AppearanceLayout;
  radius: string;
  theme: AppearanceTheme;
  readonly?: boolean;
};

export type StoredAppearanceProfiles = {
  activeProfileId: string;
  profiles: AppearanceProfile[];
};

export const APPEARANCE_STORAGE_KEY = 'pilotdeck-appearance-profiles';
export const APPEARANCE_SYNC_EVENT = 'appearance-profiles:sync';

export const DEFAULT_LOGO_LIGHT = '/logo.svg';
export const DEFAULT_LOGO_DARK = '/logo.svg';
export const DEFAULT_FAVICON = '/favicon.svg?v=pd1';
export const MAX_APPEARANCE_ASSET_BYTES = 1024 * 1024;

const neutralTheme: AppearanceTheme = {
  light: {
    background: '0 0% 100%',
    foreground: '0 0% 9%',
    card: '0 0% 100%',
    cardForeground: '0 0% 9%',
    popover: '0 0% 100%',
    popoverForeground: '0 0% 9%',
    primary: '0 0% 9%',
    primaryForeground: '0 0% 98%',
    secondary: '0 0% 96%',
    secondaryForeground: '0 0% 15%',
    muted: '0 0% 96%',
    mutedForeground: '0 0% 45%',
    accent: '0 0% 96%',
    accentForeground: '0 0% 9%',
    border: '0 0% 90%',
    input: '0 0% 90%',
    ring: '0 0% 30%',
  },
  dark: {
    background: '0 0% 4%',
    foreground: '0 0% 96%',
    card: '0 0% 4%',
    cardForeground: '0 0% 96%',
    popover: '0 0% 9%',
    popoverForeground: '0 0% 96%',
    primary: '0 0% 96%',
    primaryForeground: '0 0% 9%',
    secondary: '0 0% 15%',
    secondaryForeground: '0 0% 96%',
    muted: '0 0% 15%',
    mutedForeground: '0 0% 64%',
    accent: '0 0% 15%',
    accentForeground: '0 0% 96%',
    border: '0 0% 15%',
    input: '0 0% 25%',
    ring: '0 0% 64%',
  },
};

export const APPEARANCE_PRESETS: AppearanceProfile[] = [
  {
    id: 'preset-pilotdeck-neutral',
    name: 'PilotDeck Neutral',
    brandName: 'PilotDeck',
    tagline: 'Agent-driven development workspace',
    logoLight: DEFAULT_LOGO_LIGHT,
    logoDark: DEFAULT_LOGO_DARK,
    favicon: DEFAULT_FAVICON,
    font: 'inter',
    density: 'comfortable',
    layout: 'balanced',
    radius: '0.5rem',
    theme: neutralTheme,
    readonly: true,
  },
  {
    id: 'preset-focused-blue',
    name: 'Focused Blue',
    brandName: 'PilotDeck',
    tagline: 'Focused agent workbench',
    logoLight: DEFAULT_LOGO_LIGHT,
    logoDark: DEFAULT_LOGO_DARK,
    favicon: DEFAULT_FAVICON,
    font: 'inter',
    density: 'compact',
    layout: 'compactTools',
    radius: '0.375rem',
    theme: {
      light: {
        ...neutralTheme.light,
        primary: '214 78% 42%',
        primaryForeground: '0 0% 100%',
        accent: '214 70% 95%',
        accentForeground: '215 72% 22%',
        ring: '214 78% 42%',
        muted: '215 28% 96%',
        border: '214 28% 88%',
        input: '214 28% 88%',
      },
      dark: {
        ...neutralTheme.dark,
        background: '220 24% 7%',
        card: '220 22% 9%',
        popover: '220 22% 10%',
        primary: '213 92% 68%',
        primaryForeground: '221 39% 11%',
        accent: '217 44% 18%',
        accentForeground: '213 96% 86%',
        ring: '213 92% 68%',
        border: '218 24% 20%',
        input: '218 24% 24%',
      },
    },
    readonly: true,
  },
  {
    id: 'preset-terminal-dark',
    name: 'Terminal Dark',
    brandName: 'PilotDeck',
    tagline: 'Quiet terminal-grade workspace',
    logoLight: DEFAULT_LOGO_LIGHT,
    logoDark: DEFAULT_LOGO_DARK,
    favicon: DEFAULT_FAVICON,
    font: 'mono',
    density: 'compact',
    layout: 'compactTools',
    radius: '0.25rem',
    theme: {
      light: {
        ...neutralTheme.light,
        background: '80 14% 97%',
        card: '75 12% 99%',
        primary: '152 56% 28%',
        primaryForeground: '0 0% 100%',
        accent: '154 28% 92%',
        accentForeground: '152 44% 20%',
        ring: '152 56% 28%',
        border: '80 10% 85%',
        input: '80 10% 85%',
      },
      dark: {
        background: '150 13% 6%',
        foreground: '142 24% 91%',
        card: '150 13% 7%',
        cardForeground: '142 24% 91%',
        popover: '150 13% 8%',
        popoverForeground: '142 24% 91%',
        primary: '151 56% 52%',
        primaryForeground: '150 18% 8%',
        secondary: '150 10% 14%',
        secondaryForeground: '142 24% 91%',
        muted: '150 10% 13%',
        mutedForeground: '144 10% 62%',
        accent: '151 36% 15%',
        accentForeground: '151 56% 78%',
        border: '150 10% 19%',
        input: '150 10% 23%',
        ring: '151 56% 52%',
      },
    },
    readonly: true,
  },
  {
    id: 'preset-clean-enterprise',
    name: 'Clean Enterprise',
    brandName: 'PilotDeck',
    tagline: 'Shared AI operations console',
    logoLight: DEFAULT_LOGO_LIGHT,
    logoDark: DEFAULT_LOGO_DARK,
    favicon: DEFAULT_FAVICON,
    font: 'system',
    density: 'comfortable',
    layout: 'spacious',
    radius: '0.375rem',
    theme: {
      light: {
        ...neutralTheme.light,
        background: '210 20% 99%',
        card: '0 0% 100%',
        primary: '187 78% 28%',
        primaryForeground: '0 0% 100%',
        accent: '35 96% 92%',
        accentForeground: '30 72% 24%',
        ring: '187 78% 28%',
        border: '210 18% 88%',
        input: '210 18% 88%',
      },
      dark: {
        ...neutralTheme.dark,
        background: '205 20% 8%',
        card: '205 18% 10%',
        primary: '184 74% 47%',
        primaryForeground: '205 24% 8%',
        accent: '31 64% 18%',
        accentForeground: '35 90% 78%',
        ring: '184 74% 47%',
        border: '205 15% 22%',
        input: '205 15% 25%',
      },
    },
    readonly: true,
  },
];

export const DEFAULT_APPEARANCE_PROFILE = APPEARANCE_PRESETS[0];

const FONT_STACKS: Record<AppearanceFont, string> = {
  inter: '"InterVariable", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  system: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: '"SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
};

export function fontStackForProfile(profile: AppearanceProfile): string {
  return FONT_STACKS[profile.font] ?? FONT_STACKS.inter;
}

export function cloneProfile(profile: AppearanceProfile, overrides: Partial<AppearanceProfile> = {}): AppearanceProfile {
  return {
    ...profile,
    ...overrides,
    theme: {
      light: { ...profile.theme.light, ...overrides.theme?.light },
      dark: { ...profile.theme.dark, ...overrides.theme?.dark },
    },
  };
}

export function createProfileFromPreset(preset: AppearanceProfile, name?: string): AppearanceProfile {
  return cloneProfile(preset, {
    id: `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name?.trim() || `${preset.name} Copy`,
    readonly: false,
  });
}

export function normalizeAppearanceStore(value: unknown): StoredAppearanceProfiles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { activeProfileId: DEFAULT_APPEARANCE_PROFILE.id, profiles: [] };
  }

  const raw = value as Partial<StoredAppearanceProfiles>;
  const profiles = Array.isArray(raw.profiles)
    ? raw.profiles
      .filter((profile): profile is AppearanceProfile => Boolean(profile && typeof profile === 'object' && 'id' in profile))
      .map((profile) => normalizeProfile(profile))
    : [];
  const activeProfileId = typeof raw.activeProfileId === 'string'
    ? raw.activeProfileId
    : DEFAULT_APPEARANCE_PROFILE.id;
  const availableProfileIds = new Set([
    ...APPEARANCE_PRESETS.map((profile) => profile.id),
    ...profiles.map((profile) => profile.id),
  ]);

  return {
    activeProfileId: availableProfileIds.has(activeProfileId) ? activeProfileId : DEFAULT_APPEARANCE_PROFILE.id,
    profiles,
  };
}

export function normalizeProfile(profile: Partial<AppearanceProfile>): AppearanceProfile {
  return cloneProfile(DEFAULT_APPEARANCE_PROFILE, {
    id: typeof profile.id === 'string' && profile.id ? profile.id : createProfileFromPreset(DEFAULT_APPEARANCE_PROFILE).id,
    name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : 'Custom Profile',
    brandName: typeof profile.brandName === 'string' && profile.brandName.trim() ? profile.brandName.trim() : 'PilotDeck',
    tagline: typeof profile.tagline === 'string' ? profile.tagline : DEFAULT_APPEARANCE_PROFILE.tagline,
    logoLight: typeof profile.logoLight === 'string' ? profile.logoLight : DEFAULT_LOGO_LIGHT,
    logoDark: typeof profile.logoDark === 'string' ? profile.logoDark : DEFAULT_LOGO_DARK,
    favicon: typeof profile.favicon === 'string' ? profile.favicon : DEFAULT_FAVICON,
    font: profile.font === 'system' || profile.font === 'mono' ? profile.font : 'inter',
    density: profile.density === 'compact' ? 'compact' : 'comfortable',
    layout: profile.layout === 'compactTools' || profile.layout === 'spacious' ? profile.layout : 'balanced',
    radius: typeof profile.radius === 'string' && profile.radius ? profile.radius : '0.5rem',
    theme: {
      light: { ...DEFAULT_APPEARANCE_PROFILE.theme.light, ...profile.theme?.light },
      dark: { ...DEFAULT_APPEARANCE_PROFILE.theme.dark, ...profile.theme?.dark },
    },
    readonly: profile.readonly === true,
  });
}

export function hslTripletToHex(value: string): string {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%$/);
  if (!match) return '#000000';

  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const hueToRgb = (p: number, q: number, t: number) => {
    let next = t;
    if (next < 0) next += 1;
    if (next > 1) next -= 1;
    if (next < 1 / 6) return p + (q - p) * 6 * next;
    if (next < 1 / 2) return q;
    if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rgb = s === 0
    ? [l, l, l]
    : [
      hueToRgb(p, q, h + 1 / 3),
      hueToRgb(p, q, h),
      hueToRgb(p, q, h - 1 / 3),
    ];

  return `#${rgb.map((part) => Math.round(part * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function hexToHslTriplet(value: string): string | null {
  const normalized = value.trim().replace(/^#/, '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return null;

  const r = Number.parseInt(expanded.slice(0, 2), 16) / 255;
  const g = Number.parseInt(expanded.slice(2, 4), 16) / 255;
  const b = Number.parseInt(expanded.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function readAppearanceAssetFile(file: File, maxBytes = MAX_APPEARANCE_ASSET_BYTES): Promise<string> {
  if (file.size > maxBytes) {
    return Promise.reject(new Error('asset-too-large'));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('asset-read-error'));
      }
    };
    reader.onerror = () => reject(new Error('asset-read-error'));
    reader.readAsDataURL(file);
  });
}
