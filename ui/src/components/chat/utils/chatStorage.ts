import type { PilotDeckSettings } from '../types/types';
import { authenticatedFetch } from '../../../utils/api.js';

export const PILOTDECK_SETTINGS_KEY = 'pilotdeck-settings';

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith('draft_input_'));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

// When localStorage has no cached permission settings, fall back to the
// conservative default (false). The authoritative value lives on disk
// (~/.pilotdeck/permissions.json) and is synced to localStorage when the
// Settings page loads or after a save round-trip. This avoids the old
// problem where a browser cache clear silently re-enabled bypass mode.

export function getPilotDeckSettings(): PilotDeckSettings {
  const raw = safeLocalStorage.getItem(PILOTDECK_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      skipPermissions:
        typeof parsed.skipPermissions === 'boolean'
          ? parsed.skipPermissions
          : false,
      projectSortOrder: parsed.projectSortOrder || 'name',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }
}

export async function fetchPilotDeckPermissionSettings(): Promise<PilotDeckSettings> {
  const response = await authenticatedFetch('/api/settings/permissions');
  if (!response.ok) {
    throw new Error(`Failed to fetch permission settings: HTTP ${response.status}`);
  }
  const data = await response.json();
  return mergePermissionSettings(data.permissions);
}

export async function savePilotDeckPermissionSettings(
  updates: Partial<PilotDeckSettings>,
): Promise<PilotDeckSettings> {
  const response = await authenticatedFetch('/api/settings/permissions', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    throw new Error(`Failed to save permission settings: HTTP ${response.status}`);
  }
  const data = await response.json();
  const next = mergePermissionSettings(data.permissions);
  safeLocalStorage.setItem(PILOTDECK_SETTINGS_KEY, JSON.stringify({
    ...getPilotDeckSettings(),
    ...next,
  }));
  window.dispatchEvent(new Event('pilotdeck-settings-changed'));
  return next;
}

function mergePermissionSettings(value: unknown): PilotDeckSettings {
  const current = getPilotDeckSettings();
  const parsed = value && typeof value === 'object' ? value as Partial<PilotDeckSettings> : {};
  return {
    ...current,
    ...parsed,
    allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
    disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
    skipPermissions: Boolean(parsed.skipPermissions),
    projectSortOrder: current.projectSortOrder || 'name',
  };
}
