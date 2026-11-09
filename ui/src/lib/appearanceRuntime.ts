import { deriveLightBackgrounds, deriveAppearanceColors, hasBackgroundImage, hexToHsl, isCustomizedLightAppearance, LIGHT_APPEARANCE_KEY, normalizeLightAppearance, type LightAppearance } from './lightAppearance';

export function readLightAppearance(): LightAppearance {
  try {
    const desktop = window.pilotdeckDesktop?.getAppearance?.();
    if (desktop) return normalizeLightAppearance(desktop.lightAppearance);
    return normalizeLightAppearance(JSON.parse(localStorage.getItem(LIGHT_APPEARANCE_KEY) || 'null'));
  } catch { return normalizeLightAppearance(); }
}
// Keep persisted storage names stable. Palette tokens now follow both modes;
// wallpaper effects remain light-only and are retained when switching to dark.
export function applyLightAppearance(value: LightAppearance, dark: boolean, imageUrl: string | null = null) {
  let style = document.getElementById('pd-light-appearance') as HTMLStyleElement | null;
  if (!style) { style = document.createElement('style'); style.id = 'pd-light-appearance'; document.head.append(style); }
  const root = document.documentElement;
  root.style.removeProperty('background-color');
  const active = dark || isCustomizedLightAppearance(value);
  root.toggleAttribute('data-appearance', active);
  root.toggleAttribute('data-light-appearance', active && !dark);
  if (active && !dark) root.setAttribute('data-light-background', hasBackgroundImage(value) ? 'image' : 'solid');
  else root.removeAttribute('data-light-background');

  if (!active) { style.textContent = ''; return; }
  const c = deriveAppearanceColors(value, dark);
  const backgrounds = deriveLightBackgrounds(value, c);
  const vars: Record<string, string> = {
    '--pd-canvas': c.background, '--pd-surface': c.surface, '--pd-elevated': c.elevated, '--pd-sidebar': c.sidebar,
    '--pd-sidebar-gradient': !dark && hasBackgroundImage(value) ? 'none' : c.sidebarGradient,
    '--pd-sidebar-ink': c.sidebarInk, '--pd-sidebar-accent': c.sidebarAccent,
    '--pd-ink': c.ink, '--pd-muted': c.muted, '--pd-border': c.border,
    '--pd-accent': c.accent, '--pd-accent-strong': c.strong, '--pd-accent-soft': c.soft,
    '--pd-accent-tint': c.accentScale[1], '--pd-accent-border': c.accentBorder,
    '--pd-accent-hover': c.hover, '--pd-accent-selected': c.selected,
    '--pd-button-hover': c.accentHover, '--pd-focus': c.focus,
    '--pd-control-border': c.controlBorder, '--pd-neutral-hover': c.neutralHover,
    '--pd-accent-rgb': [1, 3, 5].map(index => parseInt(c.accent.slice(index, index + 2), 16)).join(', '),
    '--pd-accent-soft-rgb': [1, 3, 5].map(index => parseInt(c.soft.slice(index, index + 2), 16)).join(', '),
    '--pd-neutral-soft': c.neutralSoft,
    '--pd-panel-alpha': `${Math.round(c.sidebarOpacity * 100)}%`, '--pd-content-alpha': `${Math.round(c.contentOpacity * 100)}%`,
    '--pd-image-blur': `${value.background.blur}px`,
    '--pd-image-fit': value.background.fit,
    '--pd-image-position': `${value.background.positionX}% ${value.background.positionY}%`,
    '--pd-image-brightness': `${value.background.brightness}%`, '--pd-image-saturation': `${value.background.saturation}%`,
    '--pd-backdrop': !dark && hasBackgroundImage(value) ? backgrounds.backdrop : c.canvasGradient, '--pd-sidebar-fill': backgrounds.sidebar, '--pd-content-fill': backgrounds.content,
    '--pd-wallpaper': !dark && imageUrl && hasBackgroundImage(value) ? `url(${JSON.stringify(imageUrl)})` : 'none',
    '--brand': c.accent, '--brand-strong': c.strong, '--brand-soft': c.soft, '--ink': c.ink, '--app-muted': c.muted, '--line': c.border,
    '--desktop-bg': c.background,
  };
  for (const [name, scale] of [['accent', c.accentScale], ['gray', c.neutralScale]] as const) {
    scale.forEach((color, i) => { vars[`--pd-${name}-${i + 1}`] = color; });
  }
  const hsl: Record<string, string> = { background: c.surface, foreground: c.ink, card: c.elevated, 'card-foreground': c.ink, popover: c.elevated, 'popover-foreground': c.ink,
    primary: c.accent, 'primary-foreground': '#ffffff', secondary: c.neutralSoft, 'secondary-foreground': c.ink,
    muted: c.neutralSoft, 'muted-foreground': c.muted, accent: c.hover, 'accent-foreground': c.strong,
    border: c.border, input: c.controlBorder, ring: c.focus };
  for (const [key, color] of Object.entries(hsl)) vars[`--${key}`] = hexToHsl(color);
  style.textContent = `:root[data-appearance]{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}}`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c.background);
}

// Invoked by a separate head entry before mounting the application.
export function bootAppearance() {
  try {
    const desktop = window.pilotdeckDesktop?.getAppearance?.();
    const mode = desktop?.themeMode || localStorage.getItem('themeMode') || localStorage.getItem('theme') || 'system';
    const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    applyLightAppearance(readLightAppearance(), dark);
  } catch { /* Storage may be disabled; default stylesheet remains usable. */ }
}
