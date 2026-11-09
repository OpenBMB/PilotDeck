import { deriveAppearanceColors, type LightAppearance } from './lightAppearance';
import formControlsCss from '../form-controls.css?inline';

/** Only the owned same-origin memory dashboard receives interface tokens.
 * Its document text, status badges and data visualizations retain their colors. */
export function applyMemoryAppearance(doc: Document, appearance: LightAppearance, dark: boolean, reducedMotion: boolean) {
  let controls = doc.getElementById('pilotdeck-memory-controls');
  if (!controls) {
    controls = doc.createElement('style');
    controls.id = 'pilotdeck-memory-controls';
    controls.textContent = formControlsCss;
    doc.head.append(controls);
  }
  doc.documentElement.classList.toggle('dark', dark);
  let style = doc.getElementById('pilotdeck-memory-appearance');
  if (!style) { style = doc.createElement('style'); style.id = 'pilotdeck-memory-appearance'; doc.head.append(style); }
  const c = deriveAppearanceColors(appearance, dark);
  const tokens = {
    bg: c.surface, 'bg-raised': c.sidebar, 'bg-hover': c.hover, 'bg-active': c.selected,
    text: c.ink, 'text-2': c.muted, 'text-3': c.muted, border: c.border, 'border-strong': c.border,
    accent: c.accent, 'accent-hover': c.accentHover, 'accent-soft': c.soft, 'accent-on': '#ffffff', card: c.surface,
    'pd-elevated': c.elevated, 'pd-ink': c.ink, 'pd-muted': c.muted, 'pd-border': c.border,
    'pd-focus': c.focus, 'pd-accent': c.accent, 'pd-accent-strong': c.strong,
    'pd-accent-selected': c.selected, 'pd-neutral-hover': c.neutralHover,
  };
  style.textContent = `:root${dark ? '[data-theme=dark]' : ':not([data-theme=dark])'}{${Object.entries(tokens).map(([key, value]) => `--${key}:${value}`).join(';')}}`
    + (reducedMotion ? '*{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}' : '');
}
