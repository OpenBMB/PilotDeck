import type { Project } from '../../types/app';

export function isGeneralProject(project: Project): boolean {
  return project.name === 'general' || project.displayName === 'general';
}

/**
 * Choose the project used when the shell starts without an explicit route.
 * Regular projects take precedence; General is only the empty-workspace
 * fallback when no regular project exists.
 */
export function chooseDefaultProject(projects: readonly Project[]): Project | null {
  return projects.find((project) => !isGeneralProject(project))
    ?? projects.find(isGeneralProject)
    ?? null;
}
