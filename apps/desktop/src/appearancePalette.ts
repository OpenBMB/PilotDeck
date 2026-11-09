import { contrast, deriveLightColors, hasBackgroundImage, mixColor, selectedPalette, type LightAppearance } from './lightAppearance';
import { THEME_SCALES } from './themeScales';

/** Radix roles: 1–2 canvas, 3–5 interactions, 6–8 borders, 9–10 solids,
 * 11–12 text. Keep text and solid-hover separate, particularly in dark mode. */
function readable(color: string, backgrounds: readonly string[], toward: string) {
  let result = color;
  for (let i = 0; i < 64 && backgrounds.some(bg => contrast(result, bg) < 4.5); i++) result = mixColor(result, toward, .08);
  return result;
}

export function deriveAppearanceColors(value: LightAppearance, dark: boolean) {
  const light = deriveLightColors(value);
  const palette = selectedPalette(value);
  const preset = value.preset === 'custom' || value.preset === 'lavender' ? null : value.preset;
  const reference = THEME_SCALES[preset || 'gray'][dark ? 'dark' : 'light'];
  const neutral = [...reference.neutral];
  // Arbitrary custom accents use the same roles and contrast checks. Presets
  // use the exported Radix scales; a custom color is never stored as a preset.
  const accent = preset ? [...reference.accent] : (dark
    ? [.03, .07, .14, .22, .30, .40, .54, .72, 1, .9, .65, .85].map((amount, i) => i < 10 ? mixColor('#23252b', palette.accent, amount) : mixColor(palette.accent, '#ffffff', amount))
    : [.015, .035, .08, .13, .19, .27, .38, .55, 1, 1, .95, .8].map((amount, i) => i < 9 ? mixColor('#ffffff', palette.accent, amount) : mixColor(palette.accent, '#14151a', i === 11 ? .65 : .15)));
  const surface = dark ? neutral[0] : light.surface;
  const sidebar = dark ? neutral[1] : preset && !hasBackgroundImage(value) ? neutral[1] : light.sidebar;
  const sidebarEnd = mixColor(sidebar, accent[3], dark ? .35 : .55);
  const button = readable(accent[8], ['#ffffff'], '#000000');
  const hover = readable(accent[9], ['#ffffff'], '#000000');
  const text = readable(accent[10], [surface, sidebar, sidebarEnd, accent[4]], dark ? '#ffffff' : '#000000');
  return {
    ...light,
    background: dark ? '#23252b' : light.background,
    surface, sidebar,
    elevated: dark ? neutral[1] : light.surface,
    canvasGradient: `linear-gradient(135deg, ${accent[1]}, ${neutral[1]} 55%, ${accent[2]})`,
    sidebarGradient: `linear-gradient(165deg, ${sidebar}, ${sidebarEnd} 70%, ${sidebar})`,
    ink: dark ? neutral[11] : light.ink,
    muted: readable(dark ? neutral[10] : light.muted, [surface, sidebar, sidebarEnd], dark ? '#ffffff' : '#000000'),
    sidebarInk: dark ? neutral[11] : light.sidebarInk,
    sidebarAccent: dark ? text : readable(light.sidebarAccent, [sidebar, sidebarEnd], '#000000'),
    sidebarOpacity: dark ? 1 : light.sidebarOpacity,
    contentOpacity: dark ? 1 : light.contentOpacity,
    accent: button, strong: text, soft: accent[2], hover: accent[3], selected: accent[4],
    accentHover: hover, accentBorder: accent[6], focus: accent[7],
    border: neutral[5], controlBorder: neutral[6], neutralSoft: neutral[2], neutralHover: neutral[3],
    accentScale: accent, neutralScale: neutral,
  };
}
