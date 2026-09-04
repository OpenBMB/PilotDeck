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
 * General is the canonical context for conversations that are not attached
 * to a regular project. Falling back to a regular project keeps older data
 * sets that do not expose General usable without reintroducing a null state.
 */
export function chooseDefaultProject(projects: readonly Project[]): Project | null {
  return projects.find(isGeneralProject)
    ?? projects.find((project) => !isGeneralProject(project))
    ?? null;
}

/**
 * Resolve the project inherited by the global "New conversation" action.
 * Project conversations keep their workspace. Outside a project conversation,
 * General is used as a real workspace so chat and model state never diverge.
 */
export function resolveHomeNewConversationProject(
  {
    selectedProject,
    selectedSession,
    projectNameParam,
    projects,
  }: {
    selectedProject: Project | null;
    selectedSession: ProjectSession | null;
    projectNameParam?: string;
    projects: readonly Project[];
  },
): Project | null {
  return (projectNameParam || selectedSession ? selectedProject : null)
    ?? chooseDefaultProject(projects);
}
