import { describe, expect, it } from 'vitest';
import type { Project } from '../../types/app';
import { chooseDefaultProject } from './appShellSelection';

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
