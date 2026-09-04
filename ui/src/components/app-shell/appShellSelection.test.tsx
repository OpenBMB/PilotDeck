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
  it('prefers General as the default conversation context', () => {
    expect(chooseDefaultProject([general, project])).toBe(general);
  });

  it('falls back to a regular project when General is unavailable', () => {
    expect(chooseDefaultProject([project])).toBe(project);
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
      projectNameParam: project.name,
      projects: [general, project],
    })).toBe(project);
  });

  it('keeps the project for an existing project conversation', () => {
    expect(resolveHomeNewConversationProject({
      selectedProject: project,
      selectedSession: { id: 'session-1' },
      projects: [general, project],
    })).toBe(project);
  });

  it('uses General outside a project conversation context', () => {
    expect(resolveHomeNewConversationProject({
      selectedProject: project,
      selectedSession: null,
      projects: [general, project],
    })).toBe(general);
  });

  it('keeps General for an existing General conversation', () => {
    expect(resolveHomeNewConversationProject({
      selectedProject: general,
      selectedSession: { id: 'session-1' },
      projects: [general, project],
    })).toBe(general);
  });

  it('uses General when no project is selected', () => {
    expect(resolveHomeNewConversationProject({
      selectedProject: null,
      selectedSession: null,
      projects: [general, project],
    })).toBe(general);
  });
});
