import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  APPEARANCE_PRESETS,
  APPEARANCE_STORAGE_KEY,
  APPEARANCE_SYNC_EVENT,
  DEFAULT_APPEARANCE_PROFILE,
  DEFAULT_FAVICON,
  type AppearancePalette,
  type AppearanceProfile,
  type StoredAppearanceProfiles,
  cloneProfile,
  createProfileFromPreset,
  fontStackForProfile,
  hslTripletToHex,
  normalizeAppearanceStore,
  normalizeProfile,
} from '../lib/appearanceProfiles';

type AppearanceProfileContextValue = {
  presets: AppearanceProfile[];
  profiles: AppearanceProfile[];
  activeProfile: AppearanceProfile;
  activeProfileId: string;
  setActiveProfileId: (id: string) => void;
  createFromPreset: (presetId: string, name?: string) => AppearanceProfile;
  duplicateProfile: (profileId: string, name?: string) => AppearanceProfile;
  updateProfile: (id: string, patch: Partial<AppearanceProfile>) => void;
  deleteProfile: (id: string) => void;
  resetProfiles: () => void;
};

const AppearanceProfileContext = createContext<AppearanceProfileContextValue | null>(null);

const paletteKeys: Array<keyof AppearancePalette> = [
  'background',
  'foreground',
  'card',
  'cardForeground',
  'popover',
  'popoverForeground',
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'muted',
  'mutedForeground',
  'accent',
  'accentForeground',
  'border',
  'input',
  'ring',
];

const cssVarNames: Record<keyof AppearancePalette, string> = {
  background: '--background',
  foreground: '--foreground',
  card: '--card',
  cardForeground: '--card-foreground',
  popover: '--popover',
  popoverForeground: '--popover-foreground',
  primary: '--primary',
  primaryForeground: '--primary-foreground',
  secondary: '--secondary',
  secondaryForeground: '--secondary-foreground',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  accent: '--accent',
  accentForeground: '--accent-foreground',
  border: '--border',
  input: '--input',
  ring: '--ring',
};

const readInitialStore = (): StoredAppearanceProfiles => {
  if (typeof window === 'undefined') {
    return { activeProfileId: DEFAULT_APPEARANCE_PROFILE.id, profiles: [] };
  }

  try {
    return normalizeAppearanceStore(JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) || 'null'));
  } catch {
    return { activeProfileId: DEFAULT_APPEARANCE_PROFILE.id, profiles: [] };
  }
};

const sameStore = (left: StoredAppearanceProfiles, right: StoredAppearanceProfiles) => (
  JSON.stringify(left) === JSON.stringify(right)
);

const profileCatalog = (profiles: AppearanceProfile[]) => [...APPEARANCE_PRESETS, ...profiles];

const findProfile = (profiles: AppearanceProfile[], id: string) => (
  profileCatalog(profiles).find((profile) => profile.id === id) ?? DEFAULT_APPEARANCE_PROFILE
);

const setLinkHref = (selector: string, href: string) => {
  const links = document.querySelectorAll<HTMLLinkElement>(selector);
  links.forEach((link) => {
    link.href = href;
  });
};

const updateMeta = (selector: string, value: string) => {
  const meta = document.querySelector<HTMLMetaElement>(selector);
  if (meta) {
    meta.content = value;
  }
};

function applyProfileToDocument(profile: AppearanceProfile) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  root.style.setProperty('--radius', profile.radius);
  root.style.setProperty('--app-font-family', fontStackForProfile(profile));
  root.style.setProperty('--app-density-scale', profile.density === 'compact' ? '0.88' : '1');
  root.dataset.appearanceProfile = profile.id;
  root.dataset.appearanceDensity = profile.density;
  root.dataset.appearanceLayout = profile.layout;

  const style = document.getElementById('appearance-profile-vars') ?? document.createElement('style');
  style.id = 'appearance-profile-vars';
  style.textContent = [
    `:root{${paletteKeys.map((key) => `${cssVarNames[key]}:${profile.theme.light[key]};`).join('')}}`,
    `.dark{${paletteKeys.map((key) => `${cssVarNames[key]}:${profile.theme.dark[key]};`).join('')}}`,
  ].join('\n');
  document.head.appendChild(style);

  const appTitle = profile.brandName.trim() || 'PilotDeck';
  document.title = appTitle;
  updateMeta('meta[name="apple-mobile-web-app-title"]', appTitle);
  const activeBackground = root.classList.contains('dark')
    ? profile.theme.dark.background
    : profile.theme.light.background;
  updateMeta('meta[name="theme-color"]', hslTripletToHex(activeBackground));
  updateMeta('meta[name="msapplication-TileColor"]', hslTripletToHex(activeBackground));
  setLinkHref('link[rel~="icon"]', profile.favicon || DEFAULT_FAVICON);
}

export function AppearanceProfileProvider({ children }: { children: React.ReactNode }) {
  const instanceIdRef = useRef(`appearance-${Math.random().toString(36).slice(2)}`);
  const [store, setStore] = useState<StoredAppearanceProfiles>(readInitialStore);

  const activeProfile = useMemo(
    () => findProfile(store.profiles, store.activeProfileId),
    [store.activeProfileId, store.profiles],
  );

  useEffect(() => {
    applyProfileToDocument(activeProfile);
  }, [activeProfile]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const observer = new MutationObserver(() => applyProfileToDocument(activeProfile));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [activeProfile]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(store));
    window.dispatchEvent(new CustomEvent(APPEARANCE_SYNC_EVENT, {
      detail: {
        sourceId: instanceIdRef.current,
        store,
      },
    }));
  }, [store]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const applyExternalStore = (value: unknown) => {
      const next = normalizeAppearanceStore(value);
      setStore((previous) => (sameStore(previous, next) ? previous : next));
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_STORAGE_KEY || event.newValue === null) return;
      try {
        applyExternalStore(JSON.parse(event.newValue));
      } catch {
        // Ignore malformed external writes.
      }
    };

    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<{ sourceId?: string; store?: unknown }>).detail;
      if (!detail || detail.sourceId === instanceIdRef.current) return;
      applyExternalStore(detail.store);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(APPEARANCE_SYNC_EVENT, onSync as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(APPEARANCE_SYNC_EVENT, onSync as EventListener);
    };
  }, []);

  const setActiveProfileId = useCallback((id: string) => {
    setStore((previous) => ({
      ...previous,
      activeProfileId: findProfile(previous.profiles, id).id,
    }));
  }, []);

  const createFromPreset = useCallback((presetId: string, name?: string) => {
    const preset = APPEARANCE_PRESETS.find((item) => item.id === presetId) ?? DEFAULT_APPEARANCE_PROFILE;
    const next = createProfileFromPreset(preset, name);
    setStore((previous) => ({
      activeProfileId: next.id,
      profiles: [...previous.profiles, next],
    }));
    return next;
  }, []);

  const duplicateProfile = useCallback((profileId: string, name?: string) => {
    const source = findProfile(store.profiles, profileId);
    const next = createProfileFromPreset(source, name);
    setStore((previous) => ({
      activeProfileId: next.id,
      profiles: [...previous.profiles, next],
    }));
    return next;
  }, [store.profiles]);

  const updateProfile = useCallback((id: string, patch: Partial<AppearanceProfile>) => {
    setStore((previous) => {
      const existing = previous.profiles.find((profile) => profile.id === id);
      if (!existing) return previous;
      const next = normalizeProfile(cloneProfile(existing, patch));
      return {
        ...previous,
        profiles: previous.profiles.map((profile) => (profile.id === id ? next : profile)),
      };
    });
  }, []);

  const deleteProfile = useCallback((id: string) => {
    setStore((previous) => {
      const profiles = previous.profiles.filter((profile) => profile.id !== id);
      return {
        activeProfileId: previous.activeProfileId === id ? DEFAULT_APPEARANCE_PROFILE.id : previous.activeProfileId,
        profiles,
      };
    });
  }, []);

  const resetProfiles = useCallback(() => {
    setStore({ activeProfileId: DEFAULT_APPEARANCE_PROFILE.id, profiles: [] });
  }, []);

  const value = useMemo<AppearanceProfileContextValue>(() => ({
    presets: APPEARANCE_PRESETS,
    profiles: store.profiles,
    activeProfile,
    activeProfileId: activeProfile.id,
    setActiveProfileId,
    createFromPreset,
    duplicateProfile,
    updateProfile,
    deleteProfile,
    resetProfiles,
  }), [
    activeProfile,
    createFromPreset,
    deleteProfile,
    duplicateProfile,
    resetProfiles,
    setActiveProfileId,
    store.profiles,
    updateProfile,
  ]);

  return (
    <AppearanceProfileContext.Provider value={value}>
      {children}
    </AppearanceProfileContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppearanceProfile() {
  const context = useContext(AppearanceProfileContext);
  if (!context) {
    throw new Error('useAppearanceProfile must be used within AppearanceProfileProvider');
  }
  return context;
}
