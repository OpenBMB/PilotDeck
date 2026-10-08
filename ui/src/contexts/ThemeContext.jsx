import React, { createContext, useContext, useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { LIGHT_APPEARANCE_KEY, normalizeLightAppearance, withoutMissingImage } from '../lib/lightAppearance';
import { applyLightAppearance, readLightAppearance } from '../lib/appearanceRuntime';
import { loadBackgroundImage, deleteBackgroundImage } from '../lib/appearanceImages';
import { useInterfacePreferences } from '../hooks/useInterfacePreferences';

const ThemeContext = createContext();
const normalizeMode = value => ['system', 'light', 'dark'].includes(value) ? value : null;
const systemDark = () => Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
function initialMode() {
  try { return normalizeMode(window.pilotdeckDesktop?.getAppearance?.()?.themeMode) || normalizeMode(localStorage.getItem('themeMode')) || normalizeMode(localStorage.getItem('theme')) || 'system'; }
  catch { return 'system'; }
}
// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
};
export const ThemeProvider = ({ children }) => {
  const interfaceState = useInterfacePreferences();
  const [themeMode, setThemeMode] = useState(initialMode);
  const [systemIsDark, setSystemIsDark] = useState(systemDark);
  const isDarkMode = themeMode === 'system' ? systemIsDark : themeMode === 'dark';
  const [lightAppearance, setLightAppearance] = useState(readLightAppearance);
  const current = useRef(lightAppearance);
  const saved = useRef(lightAppearance);
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const [appearanceError, setAppearanceError] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [imageMissing, setImageMissing] = useState(false);

  // Serialize writes; only the latest failed edit may roll back the visible UI.
  const updateLightAppearance = useCallback((update) => {
    const next = normalizeLightAppearance(typeof update === 'function' ? update(current.current) : update);
    const request = ++revision.current;
    current.current = next;
    setLightAppearance(next);
    setAppearanceError(null);
    const write = queue.current.then(async () => {
      try {
        if (window.pilotdeckDesktop?.setAppearance) await window.pilotdeckDesktop.setAppearance({ lightAppearance: next });
        else localStorage.setItem(LIGHT_APPEARANCE_KEY, JSON.stringify(next));
        const previousId = saved.current.background.imageId;
        saved.current = next;
        if (previousId && previousId !== next.background.imageId) void deleteBackgroundImage(previousId).catch(() => {});
        return true;
      } catch {
        if (request === revision.current) {
          current.current = saved.current;
          setLightAppearance(saved.current);
          setAppearanceError('saveFailed');
        }
        return false;
      }
    });
    queue.current = write.then(() => undefined);
    return write;
  }, []);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute('content', isDarkMode ? 'black-translucent' : 'default');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDarkMode ? '#0c1117' : '#ffffff');
    applyLightAppearance(withoutMissingImage(lightAppearance, imageMissing), isDarkMode, imageUrl);
  }, [lightAppearance, isDarkMode, imageUrl, imageMissing]);
  useEffect(() => {
    try {
      localStorage.setItem('themeMode', themeMode);
      if (themeMode === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', themeMode);
    } catch { /* The current session remains usable without browser storage. */ }
  }, [themeMode]);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    const change = e => setSystemIsDark(e.matches);
    query?.addEventListener('change', change);
    return () => query?.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    let cancelled = false;
    let loaded;
    setImageUrl(null);
    setImageMissing(false);
    const id = lightAppearance.background.imageId;
    if (id) loadBackgroundImage(id).then(url => {
      loaded = url;
      if (cancelled) { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }
      else setImageUrl(url);
    }).catch(() => { if (!cancelled) setImageMissing(true); });
    return () => { cancelled = true; if (loaded?.startsWith('blob:')) URL.revokeObjectURL(loaded); };
  }, [lightAppearance.background.imageId]);
  useEffect(() => {
    const sync = event => {
      if (event.key !== LIGHT_APPEARANCE_KEY || window.pilotdeckDesktop) return;
      try {
        const next = normalizeLightAppearance(JSON.parse(event.newValue || 'null'));
        current.current = saved.current = next;
        setLightAppearance(next);
      } catch { /* Ignore malformed external changes. */ }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const value = {
    ...interfaceState,
    isDarkMode, themeMode, setThemeMode, toggleDarkMode: () => setThemeMode(isDarkMode ? 'light' : 'dark'),
    lightAppearance, updateLightAppearance,
    resetLightAppearance: () => updateLightAppearance(normalizeLightAppearance()),
    appearanceError, imageUrl, imageMissing,
  };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
