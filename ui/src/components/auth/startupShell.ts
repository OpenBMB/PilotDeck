import type { StartupTiming } from '../../../../apps/desktop/src/startupPresentation';

export function hasStartupShell() {
  return Boolean(window.__pilotdeckStartupUpdate && document.getElementById('startup'));
}

export function updateStartupShell(state: StartupTiming, language: string, leaving: boolean) {
  const element = document.getElementById('startup');
  if (!element || !window.__pilotdeckStartupUpdate) return;
  element.style.visibility = 'visible';
  window.__pilotdeckStartupUpdate({ ...state, language, leaving });
}

export function hideStartupShell() {
  const element = document.getElementById('startup');
  if (element) element.style.visibility = 'hidden';
}

export function releaseStartupShell() {
  window.__pilotdeckStartupCleanup?.();
  document.getElementById('pilotdeck-startup-shell')?.remove();
  delete window.__pilotdeckStartupCleanup;
  delete window.__pilotdeckStartupUpdate;
}
