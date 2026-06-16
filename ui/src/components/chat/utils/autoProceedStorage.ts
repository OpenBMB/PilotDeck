/**
 * Per-session auto-proceed state, persisted in localStorage.
 * Keys: autoProceed_<sessionId> → '1' | '0'
 *
 * When no stored value exists, the global autoProceedOn setting serves as
 * the default (true for new sessions when the feature is enabled).
 */
const AUTO_PROCEED_PREFIX = 'autoProceed_';

import { getPilotDeckSettings } from './chatStorage';

export function getAutoProceed(sessionId: string): boolean {
  if (!sessionId) return false;
  try {
    const stored = window.localStorage.getItem(AUTO_PROCEED_PREFIX + sessionId);
    if (stored === '0') return false;
    if (stored === '1') return true;
    // No stored value → use global setting as default
    const settings = getPilotDeckSettings();
    return settings.autoProceedOn !== false;
  } catch {
    // If anything fails, default to on
    return true;
  }
}

export function setAutoProceed(sessionId: string, active: boolean): void {
  if (!sessionId) return;
  try {
    window.localStorage.setItem(AUTO_PROCEED_PREFIX + sessionId, active ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

/** Toggle the current value and return the new state. */
export function toggleAutoProceed(sessionId: string): boolean {
  const next = !getAutoProceed(sessionId);
  setAutoProceed(sessionId, next);
  return next;
}
