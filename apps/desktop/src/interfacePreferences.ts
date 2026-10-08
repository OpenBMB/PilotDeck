export type InterfacePreferences = {
  reducedMotion: 'system' | 'on' | 'off';
  hardwareAcceleration: boolean;
};
export const INTERFACE_PREFERENCES_KEY = 'pilotdeck-interface-preferences-v1';
export function normalizeInterfacePreferences(value?: unknown): InterfacePreferences {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    reducedMotion: v.reducedMotion === 'on' || v.reducedMotion === 'off' ? v.reducedMotion : 'system',
    hardwareAcceleration: v.hardwareAcceleration !== false,
  };
}
