import { deriveAppearanceColors, isCustomizedLightAppearance, type LightAppearance } from './lightAppearance';

/** Only the owned same-origin memory dashboard receives interface tokens.
 * Its document text, status badges and data visualizations retain their colors. */
export function applyMemoryAppearance(doc: Document, appearance: LightAppearance, dark: boolean, reducedMotion: boolean) {
  let style = doc.getElementById('pilotdeck-memory-appearance');
  if (!style) { style = doc.createElement('style'); style.id = 'pilotdeck-memory-appearance'; doc.head.append(style); }
  const c = deriveAppearanceColors(appearance, dark);
  const tokens = {
    bg: c.surface, 'bg-raised': c.sidebar, 'bg-hover': c.hover, 'bg-active': c.selected,
    text: c.ink, 'text-2': c.muted, 'text-3': c.muted, border: c.border, 'border-strong': c.border,
    accent: c.accent, 'accent-hover': c.accentHover, 'accent-soft': c.soft, 'accent-on': '#ffffff', card: c.surface,
  };
  const customized = isCustomizedLightAppearance(appearance);
  style.textContent = (dark || customized ? `:root${dark ? '[data-theme=dark]' : ':not([data-theme=dark])'}{${Object.entries(tokens).map(([key, value]) => `--${key}:${value}`).join(';')}}` : '')
    + (reducedMotion ? '*{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}' : '');
}
