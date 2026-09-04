import type { Project, ProjectSession } from '../../types/app';
import { projectDisplayName } from '../../lib/customNames';

export function isGeneralProject(project: Project): boolean {
  return project.name === 'general' || project.displayName === 'general';
}

const asTimestamp = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

/** Same order as the sidebar project list: lastActivity desc, then display name. */
export function compareProjectsBySidebarOrder(left: Project, right: Project): number {
  const diff = asTimestamp(right.lastActivity) - asTimestamp(left.lastActivity);
  if (diff !== 0) return diff;
  return projectDisplayName(left).localeCompare(projectDisplayName(right));
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

/**
 * Resolve the project inherited by the global "New conversation" action.
 * A project draft keeps its workspace, while an existing transcript starts a
 * fresh unbound conversation even though the shell still knows its project.
 */
export function resolveHomeNewConversationProject(
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): Project | null {
  if (selectedSession || !selectedProject || isGeneralProject(selectedProject)) {
    return null;
  }
  return selectedProject;
}
