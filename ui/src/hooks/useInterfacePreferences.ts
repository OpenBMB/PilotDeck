import { useCallback, useEffect, useRef, useState } from 'react';
import { INTERFACE_PREFERENCES_KEY, normalizeInterfacePreferences, type InterfacePreferences } from '../lib/interfacePreferences';

function read() {
  try {
    const desktop = window.pilotdeckDesktop?.getAppearance?.();
    return normalizeInterfacePreferences(desktop ? desktop.interfacePreferences : JSON.parse(localStorage.getItem(INTERFACE_PREFERENCES_KEY) || 'null'));
  } catch { return normalizeInterfacePreferences(); }
}
export function useInterfacePreferences() {
  const [preferences, setPreferences] = useState(read);
  const current = useRef(preferences);
  const saved = useRef(preferences);
  const revision = useRef(0);
  const queue = useRef(Promise.resolve());
  const [preferencesError, setError] = useState(false);
  const updatePreferences = useCallback((patch: Partial<InterfacePreferences>) => {
    const next = normalizeInterfacePreferences({ ...current.current, ...patch });
    const request = ++revision.current;
    current.current = next; setPreferences(next); setError(false);
    const write = queue.current.then(async () => {
      try {
        if (window.pilotdeckDesktop?.setAppearance) await window.pilotdeckDesktop.setAppearance({ interfacePreferences: next });
        else localStorage.setItem(INTERFACE_PREFERENCES_KEY, JSON.stringify(next));
        saved.current = next;
        return true;
      } catch {
        if (request === revision.current) { current.current = saved.current; setPreferences(saved.current); setError(true); }
        return false;
      }
    });
    queue.current = write.then(() => undefined);
    return write;
  }, []);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const apply = () => document.documentElement.toggleAttribute('data-reduced-motion', preferences.reducedMotion === 'on' || (preferences.reducedMotion === 'system' && !!media?.matches));
    apply(); media?.addEventListener('change', apply);
    return () => media?.removeEventListener('change', apply);
  }, [preferences.reducedMotion]);
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === INTERFACE_PREFERENCES_KEY && !window.pilotdeckDesktop) {
        current.current = saved.current = read(); setPreferences(current.current);
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return { preferences, updatePreferences, preferencesError };
}
