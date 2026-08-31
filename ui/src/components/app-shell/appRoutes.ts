export const SCHEDULED_TASKS_PATH = '/cron';
export const SKILLS_PATH = '/skills';

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
