import { describe, expect, it } from 'vitest';
import type { Project } from '../../types/app';
import { chooseDefaultProject, compareProjectsBySidebarOrder } from './appShellSelection';

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
