// Settings-shaped projection of a Project — used by the Settings modal so
// we don't pass through optional fields it doesn't need. Lives in `lib/`
// (vs. the legacy `components/sidebar/`) because the V2 shell is the only
// remaining caller after the V1 sidebar tear-down.
import type { Project } from '../types/app';

export type SettingsProject = Pick<Project, 'name' | 'displayName' | 'fullPath' | 'path'>;

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  return {
    name: project.name,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.name,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
