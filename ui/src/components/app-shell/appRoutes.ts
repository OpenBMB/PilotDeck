import { useMatch } from 'react-router-dom';

export const SCHEDULED_TASKS_PATH = '/cron';
export const SKILLS_PATH = '/skills';
export const SETTINGS_PATH = '/settings';
export const SETTINGS_SECTION_PATH = '/settings/:section';

// The auth gate and shell must agree on which URLs actually render Settings.
// A prefix check would also admit nested URLs that the shell treats as chat.
export function useSettingsRouteMatch() {
  const index = useMatch({ path: SETTINGS_PATH, end: true });
  const section = useMatch({ path: SETTINGS_SECTION_PATH, end: true });
  return section ?? index;
}

export const DEDICATED_TAB_PATHS = {
  cron: SCHEDULED_TASKS_PATH,
  skills: SKILLS_PATH,
} as const;

export type DedicatedTab = keyof typeof DEDICATED_TAB_PATHS;

export function getDedicatedTabPath(tab: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DEDICATED_TAB_PATHS, tab)
    ? DEDICATED_TAB_PATHS[tab as DedicatedTab]
    : undefined;
}
