import type { Project } from '../types/app';
import type { AgentGroup } from '../types/group';

export function groupWorkspaceProjectName(groupId: string): string {
  return `group:${groupId}`;
}

export function groupWorkspaceProject(group: AgentGroup): Project {
  const pathSegments = group.projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const boundProjectLabel = pathSegments[pathSegments.length - 1] || group.projectName;
  return {
    name: groupWorkspaceProjectName(group.id),
    displayName: group.projectName === 'general' ? 'General' : boundProjectLabel,
    fullPath: group.projectPath,
    path: group.projectPath,
    projectRole: group.projectRole,
    sessions: [],
  };
}
