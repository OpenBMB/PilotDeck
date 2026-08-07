import { describe, expect, it } from 'vitest';
import type { AgentGroup } from '../types/group';
import { groupWorkspaceProject, groupWorkspaceProjectName } from './groupWorkspaceProject';

describe('groupWorkspaceProject', () => {
  it('uses the durable group route while preserving the bound project path', () => {
    const group = {
      id: 'group-1',
      projectName: 'general',
      projectPath: '/workspace/original-general',
      projectRole: 'editor',
    } as AgentGroup;

    expect(groupWorkspaceProjectName(group.id)).toBe('group:group-1');
    expect(groupWorkspaceProject(group)).toMatchObject({
      name: 'group:group-1',
      displayName: 'General',
      fullPath: '/workspace/original-general',
      path: '/workspace/original-general',
      projectRole: 'editor',
    });
  });

  it('uses the bound directory name as the project label', () => {
    const group = {
      id: 'group-office',
      projectName: 'Users-hx-pd_proj-office_01',
      projectPath: '/Users/hx/pd_proj/office_01',
      projectRole: 'owner',
    } as AgentGroup;

    expect(groupWorkspaceProject(group).displayName).toBe('office_01');
  });
});
