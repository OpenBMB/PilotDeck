import type { BrowserWindowConstructorOptions, Input } from 'electron';
import { deriveLightColors, isCustomizedLightAppearance, normalizeLightAppearance } from './lightAppearance';

/** Only plain platform Find/Bold shortcuts belong to the focused renderer. */
export function isRendererEditingShortcut(platform: NodeJS.Platform, input: Pick<Input, 'key' | 'control' | 'meta' | 'alt' | 'shift' | 'isComposing'>): boolean {
  const modifier = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  return modifier && !input.alt && !input.shift && !input.isComposing
    && ['b', 'f'].includes(input.key.toLowerCase());
}

export const WINDOWS_CAPTION_HEIGHT = 32;
export const MAC_CAPTION_HEIGHT = 48;
export const WINDOWS_MENUS = [
  { id: 'menu-file', en: 'File', zh: '文件', key: 'f' },
  { id: 'menu-edit', en: 'Edit', zh: '编辑', key: 'e' },
  { id: 'menu-view', en: 'View', zh: '查看', key: 'v' },
  { id: 'menu-go', en: 'Go', zh: '前往', key: 'g' },
  { id: 'menu-help', en: 'Help', zh: '帮助', key: 'h' },
] as const;

/** One opaque palette for the native buttons and the adjacent HTML caption. */
export function windowPalette(dark: boolean, platform: NodeJS.Platform = process.platform, lightAppearance?: unknown) {
  const palette = { background: dark ? '#0a0a0a' : '#ffffff', caption: platform === 'win32' || platform === 'linux' ? (dark ? '#171717' : '#f4f4f5') : (dark ? '#0a0a0a' : '#fbfaff'), symbol: dark ? '#e5e5e5' : '#262626' };
  const appearance = normalizeLightAppearance(lightAppearance);
  if (!dark && isCustomizedLightAppearance(appearance)) {
    const colors = deriveLightColors(appearance);
    return { background: colors.background, caption: colors.sidebar, symbol: colors.ink };
  }
  return palette;
}
export function windowChromeOptions(platform: NodeJS.Platform, dark: boolean, lightAppearance?: unknown): BrowserWindowConstructorOptions {
  const palette = windowPalette(dark, platform, lightAppearance);
  return {
    backgroundColor: palette.background,
    ...(platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : {}),
    ...(platform === 'win32' || platform === 'linux' ? { titleBarStyle: 'hidden', titleBarOverlay: {
      height: WINDOWS_CAPTION_HEIGHT, color: palette.caption, symbolColor: palette.symbol,
    } } : {}),
  };
}
