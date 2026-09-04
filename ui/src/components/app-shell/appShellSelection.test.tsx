import { describe, expect, it } from 'vitest';
import type { Project } from '../../types/app';
import {
  chooseDefaultProject,
  compareProjectsBySidebarOrder,
  resolveHomeNewConversationProject,
} from './appShellSelection';

const general: Project = {
  name: 'general',
  displayName: 'general',
  fullPath: '/workspace/general',
};

const project: Project = {
  name: 'pilotdeck',
  displayName: 'PilotDeck',
  fullPath: '/workspace/PilotDeck',
};

describe('chooseDefaultProject', () => {
  it('prefers a regular project over General', () => {
    expect(chooseDefaultProject([general, project])).toBe(project);
  });

  it('falls back to General when no regular project exists', () => {
    expect(chooseDefaultProject([general])).toBe(general);
  });

  it('returns null when there are no projects', () => {
    expect(chooseDefaultProject([])).toBeNull();
  });
});

describe('compareProjectsBySidebarOrder', () => {
  it('sorts by lastActivity descending then display name', () => {
    const older: Project = { ...project, name: 'a', displayName: 'alpha', lastActivity: 1 };
    const newer: Project = { ...project, name: 'b', displayName: 'beta', lastActivity: 2 };
    const sameTimeZ: Project = { ...project, name: 'z', displayName: 'zeta', lastActivity: 2 };
    const ordered = [older, sameTimeZ, newer].sort(compareProjectsBySidebarOrder);
    expect(ordered.map((item) => item.displayName)).toEqual(['beta', 'zeta', 'alpha']);
  });
});

describe('resolveHomeNewConversationProject', () => {
  it('keeps the project selected for an unsaved project conversation', () => {
    expect(resolveHomeNewConversationProject({
      selectedProject: project,
      selectedSession: null,
      workspaceBinding: null,
      projectNameParam: project.name,
    })).toBe(project);
  });

  it('keeps the project for an existing project conversation', () => {
    expect(resolveHomeNewConversationProject({
      selectedProject: project,
      selectedSession: { id: 'session-1' },
      workspaceBinding: null,
    })).toBe(project);
  });

  it('keeps a workspace chosen from the unbound conversation screen', () => {
    expect(resolveHomeNewConversationProject({
      selectedProject: null,
      selectedSession: null,
      workspaceBinding: project,
    })).toBe(project);
  });

  it('treats General as an unbound conversation', () => {
    expect(resolveHomeNewConversationProject({
      selectedProject: general,
      selectedSession: { id: 'session-1' },
      workspaceBinding: null,
    })).toBeNull();
  });

  it('does not reuse a project outside a project conversation context', () => {
    expect(resolveHomeNewConversationProject({
      selectedProject: project,
      selectedSession: null,
      workspaceBinding: null,
    })).toBeNull();
  });
});
