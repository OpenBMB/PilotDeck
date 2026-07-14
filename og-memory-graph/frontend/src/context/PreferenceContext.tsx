



import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchPreferences, setPreference } from '../api/client';

export interface UserPreferences {
  preferred_model: string;
  default_flags: string[];
  chat_model: string;
  response_language: 'zh' | 'en';
  expertise_level: 'beginner' | 'researcher' | 'expert';
}

const DEFAULT_PREFS: UserPreferences = {
  preferred_model: 'deepseek-v4-pro',
  default_flags: [],
  chat_model: 'deepseek-v4-pro',
  response_language: 'zh',
  expertise_level: 'researcher'
};

interface PreferenceCtx {
  prefs: UserPreferences;
  loading: boolean;
  update: (key: keyof UserPreferences, value: unknown) => Promise<void>;
  reload: () => void;
}

const Ctx = createContext<PreferenceCtx>({
  prefs: DEFAULT_PREFS,
  loading: true,
  update: async () => {},
  reload: () => {}
});

export function PreferenceProvider({ children }: {children: ReactNode;}) {
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    setLoading(true);
    fetchPreferences().
    then((p) => setPrefs({ ...DEFAULT_PREFS, ...p })).
    catch(() => {}).
    finally(() => setLoading(false));
  };

  useEffect(() => {reload();}, []);

  const update = async (key: keyof UserPreferences, value: unknown) => {
    await setPreference(key, value);
    setPrefs((prev) => ({ ...prev, [key]: value }));
  };

  return <Ctx.Provider value={{ prefs, loading, update, reload }}>{children}</Ctx.Provider>;
}

export const usePreferences = () => useContext(Ctx);
