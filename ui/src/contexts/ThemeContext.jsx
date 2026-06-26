import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();
const THEME_MODE_KEY = 'themeMode';
const LEGACY_THEME_KEY = 'theme';

const getSystemDarkMode = () => (
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-color-scheme: dark)').matches
);

const normalizeThemeMode = (value) => (
  value === 'light' || value === 'dark' || value === 'system' ? value : null
);

const readInitialThemeMode = () => {
  const savedMode = normalizeThemeMode(localStorage.getItem(THEME_MODE_KEY));
  if (savedMode) return savedMode;

  const legacyTheme = normalizeThemeMode(localStorage.getItem(LEGACY_THEME_KEY));
  if (legacyTheme === 'light' || legacyTheme === 'dark') return legacyTheme;

  return 'system';
};

const resolveThemeMode = (mode) => (
  mode === 'system' ? getSystemDarkMode() : mode === 'dark'
);

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  const [themeMode, setThemeMode] = useState(readInitialThemeMode);
  const [isDarkMode, setIsDarkMode] = useState(() => resolveThemeMode(readInitialThemeMode()));

  // Update document class and localStorage when theme changes
  useEffect(() => {
    const nextIsDark = resolveThemeMode(themeMode);
    setIsDarkMode(nextIsDark);

    if (nextIsDark) {
      document.documentElement.classList.add('dark');

      // Update iOS status bar style and theme color for dark mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'black-translucent');
      }
      
    } else {
      document.documentElement.classList.remove('dark');
      
      // Update iOS status bar style and theme color for light mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'default');
      }
      
    }

    localStorage.setItem(THEME_MODE_KEY, themeMode);
    if (themeMode === 'system') {
      localStorage.removeItem(LEGACY_THEME_KEY);
    } else {
      localStorage.setItem(LEGACY_THEME_KEY, themeMode);
    }
  }, [isDarkMode, themeMode]);

  // Listen for system theme changes
  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      if (themeMode === 'system') {
        setIsDarkMode(e.matches);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themeMode]);

  const toggleDarkMode = () => {
    setThemeMode(isDarkMode ? 'light' : 'dark');
  };

  const value = {
    isDarkMode,
    themeMode,
    setThemeMode,
    toggleDarkMode,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
