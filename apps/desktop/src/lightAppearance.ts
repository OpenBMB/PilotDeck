/** Shared, environment-independent contract used by Electron and the Web UI. */
export type ThemeMode = 'system' | 'light' | 'dark';
export type LightPalette = { accent: string; background: string };
export const LIGHT_PRESETS = {
  default: { accent: '#5b5ce2', background: '#eef0f8' },
  blue: { accent: '#386ab4', background: '#eaf1fb' },
  mint: { accent: '#187c65', background: '#eaf5ef' },
  apricot: { accent: '#a56028', background: '#fbf0e5' },
  lavender: { accent: '#7955b3', background: '#f1ecfa' },
  rose: { accent: '#b24d72', background: '#faedf2' },
} satisfies Record<string, LightPalette>;
export type LightPreset = keyof typeof LIGHT_PRESETS | 'custom';
export type LightAppearance = {
  version: 2;
  preset: LightPreset;
  custom: LightPalette;
  background: {
    type: 'solid' | 'image';
    imageId: string | null;
    fit: 'cover' | 'contain';
    blur: number;
    brightness: number;
    saturation: number;
    positionX: number;
    positionY: number;
  };
  /** How much of the wallpaper shows through the interface panels (%). */
  transparency: number;
};
export const LIGHT_APPEARANCE_KEY = 'pilotdeck-light-appearance-v1';
export const MIN_TRANSPARENCY = 5;
export const MAX_TRANSPARENCY = 40;
export const DEFAULT_TRANSPARENCY = 15;
/** The reading panel stays slightly more opaque than the sidebar. */
const CONTENT_OPACITY_OFFSET = 5;
const MAX_CONTENT_OPACITY = 95;
export const MAX_BACKGROUND_BYTES = 10 * 1024 * 1024;
export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
export const isImageId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.(?:png|webp)$/i.test(value);
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bounded = (v: unknown, min: number, max: number, fallback: number) => finite(v) ? Math.round(Math.min(max, Math.max(min, v))) : fallback;
const hex = (v: unknown, fallback: string) => isHexColor(v) ? v.toLowerCase() : fallback;
/** Version 1 stored an image intensity plus a sidebar opacity (and later a
 * separate reading-panel opacity). The visible wallpaper was effectively
 * intensity × (1 − sidebar opacity); keep that amount with a fully opaque
 * image. Untouched old defaults adopt the new default. */
function migrateTransparency(v: Record<string, unknown>, b: Record<string, unknown>): number {
  if (finite(v.transparency)) return bounded(v.transparency, MIN_TRANSPARENCY, MAX_TRANSPARENCY, DEFAULT_TRANSPARENCY);
  if (!finite(v.panelOpacity) && !finite(b.intensity)) return DEFAULT_TRANSPARENCY;
  // A former "solid panel" (100) setting hid the wallpaper; show it again.
  const panel = v.panelOpacity === 100 ? 85 : bounded(v.panelOpacity, 60, 95, 85);
  const intensity = bounded(b.intensity, 0, 100, 65);
  if (panel === 85 && intensity === 65) return DEFAULT_TRANSPARENCY;
  return bounded(intensity * (100 - panel) / 100, MIN_TRANSPARENCY, MAX_TRANSPARENCY, DEFAULT_TRANSPARENCY);
}
export function normalizeLightAppearance(value?: unknown): LightAppearance {
  const v = record(value);
  const c = record(v.custom);
  const b = record(v.background);
  return {
    version: 2,
    preset: v.preset === 'custom' || (typeof v.preset === 'string' && Object.prototype.hasOwnProperty.call(LIGHT_PRESETS, v.preset)) ? v.preset as LightPreset : 'default',
    custom: { accent: hex(c.accent, LIGHT_PRESETS.default.accent), background: hex(c.background, LIGHT_PRESETS.default.background) },
    background: {
      // The former gradient option is folded into solid: its start color is the
      // palette background, so existing configurations keep their main color.
      type: b.type === 'image' ? 'image' : 'solid',
      imageId: isImageId(b.imageId) ? b.imageId : null,
      fit: b.fit === 'contain' ? 'contain' : 'cover',
      blur: bounded(b.blur, 0, 30, 0),
      brightness: bounded(b.brightness, 50, 150, 100), saturation: bounded(b.saturation, 0, 150, 100),
      positionX: bounded(b.positionX, 0, 100, 50), positionY: bounded(b.positionY, 0, 100, 50),
    },
    transparency: migrateTransparency(v, b),
  };
}
/** Opacity (%) of the sidebar and the reading panel over a wallpaper. */
export function panelOpacities(value: LightAppearance) {
  const sidebar = 100 - value.transparency;
  return { sidebar, content: Math.min(MAX_CONTENT_OPACITY, sidebar + CONTENT_OPACITY_OFFSET) };
}
export function selectedPalette(value: LightAppearance): LightPalette {
  return value.preset === 'custom' ? value.custom : LIGHT_PRESETS[value.preset];
}
/** The image background only takes effect once an image exists. Until then
 * (or when the saved file is gone) the interface renders the solid background. */
export function hasBackgroundImage(value: LightAppearance): boolean {
  return value.background.type === 'image' && value.background.imageId !== null;
}
/** What to render when the saved image could not be loaded: the stored
 * setting is kept (the user may restore the file), the view falls back. */
export function withoutMissingImage(value: LightAppearance, missing: boolean): LightAppearance {
  return missing && value.background.imageId ? { ...value, background: { ...value.background, imageId: null } } : value;
}
/** Panel opacity only matters when a wallpaper sits behind the panels. */
export function isCustomizedLightAppearance(value: LightAppearance): boolean {
  return value.preset !== 'default' || hasBackgroundImage(value);
}
export function mixColor(a: string, b: string, amount: number): string {
  const channels = [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - amount) + parseInt(b.slice(i, i + 2), 16) * amount));
  return '#' + channels.map(v => v.toString(16).padStart(2, '0')).join('');
}
export function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
function readable(color: string, surface: string, ratio = 4.5): string {
  let result = color;
  for (let i = 0; i < 32 && contrast(result, surface) < ratio; i++) result = mixColor(result, '#000000', .12);
  return result;
}
export function hexToHsl(color: string): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) { s = d / (1 - Math.abs(2 * l - 1)); h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; }
  return `${+(h * 60).toFixed(2)} ${+(s * 100).toFixed(2)}% ${+(l * 100).toFixed(2)}%`;
}
/** The reading surface (chat, settings pages, cards, inputs) stays white like
 * the original theme. A palette only tints the window chrome: canvas, sidebar
 * and toolbars. With a wallpaper, white panels become translucent instead. */
export const LIGHT_SURFACE = '#ffffff';
export function deriveLightColors(value: LightAppearance) {
  const palette = selectedPalette(value);
  const surface = LIGHT_SURFACE;
  const image = hasBackgroundImage(value);
  // Keep the chosen hue in the sidebar. Only lift dark/saturated colors enough
  // for a light interface; controls and overlays retain a solid surface.
  const lightPanel = (color: string) => {
    let result = mixColor(color, '#ffffff', .12);
    for (let i = 0; i < 32 && contrast('#252737', result) < 10; i++) result = mixColor(result, '#ffffff', .12);
    return result;
  };
  const originalDefault = !isCustomizedLightAppearance(value);
  const sidebar = image || originalDefault ? surface : lightPanel(palette.background);
  const ink = '#252737';
  const accent = readable(palette.accent, surface);
  // Solid panels are opaque. Over a wallpaper, even a black image behind a
  // translucent panel must leave its labels readable: use the darkest
  // composite and a small margin for browser compositing/rounding.
  const opacity = panelOpacities(value);
  const sidebarOpacity = image ? opacity.sidebar / 100 : 1;
  const contentOpacity = image ? opacity.content / 100 : 1;
  const sidebarWorstCase = mixColor(sidebar, '#000000', 1 - sidebarOpacity);
  const contentWorstCase = mixColor(surface, '#000000', 1 - contentOpacity);
  const onPanels = (color: string) => readable(color, sidebarWorstCase, 4.6);
  return { ...palette, accent, surface, sidebar, ink: readable(ink, contentWorstCase, 4.6),
    sidebarInk: onPanels(ink),
    sidebarAccent: onPanels(accent),
    muted: readable(readable('#858998', surface), contentWorstCase, 4.6),
    strong: mixColor(accent, '#10121b', .15),
    soft: mixColor(accent, surface, .90),
    border: mixColor(palette.background, '#252737', .15),
    sidebarOpacity,
    contentOpacity,
  };
}

/** Shared fills for the application and its background preview. */
export function deriveLightBackgrounds(value: LightAppearance, colors = deriveLightColors(value)) {
  const fill = (color: string, opacity: number) => opacity === 1 ? color : `color-mix(in srgb, ${color} ${Math.round(opacity * 100)}%, transparent)`;
  return {
    backdrop: colors.background,
    sidebar: fill(colors.sidebar, colors.sidebarOpacity),
    content: fill(colors.surface, colors.contentOpacity),
  };
}
