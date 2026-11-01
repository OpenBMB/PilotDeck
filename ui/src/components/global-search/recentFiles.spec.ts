// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetRecentFiles, readRecentFiles, recordRecentFile, workspaceRecentFile } from './recentFiles';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('recent file visits', () => {
  it('persists unique project/path visits in access order and ignores late older responses', () => {
    const first = { projectName: 'one', path: 'docs/a.md', visitedAt: 1 };
    recordRecentFile('alice', first);
    recordRecentFile('alice', { ...first, projectName: 'two', visitedAt: 2 });
    recordRecentFile('alice', { ...first, visitedAt: 3 });
    recordRecentFile('alice', first);
    expect(readRecentFiles('alice').map(file => [file.projectName, file.visitedAt])).toEqual([['one', 3], ['two', 2]]);
    expect(readRecentFiles('bob')).toEqual([]);
    forgetRecentFiles('alice', [first]);
    expect(readRecentFiles('alice').map(file => file.projectName)).toEqual(['two']);
  });

  it('bounds stored history and rejects invalid/outside-workspace paths', () => {
    for (let index = 1; index <= 53; index++) recordRecentFile('alice', { projectName: 'one', path: index + '.md', visitedAt: index });
    expect(readRecentFiles('alice')).toHaveLength(50);
    expect(readRecentFiles('alice').at(-1)?.path).toBe('4.md');
    const project = { name: 'one', displayName: 'One', fullPath: '/workspace' };
    expect(workspaceRecentFile(project, '/workspace/docs/a.md', 1)?.path).toBe('docs/a.md');
    expect(workspaceRecentFile(project, '/elsewhere/a.md')).toBeNull();
    expect(workspaceRecentFile(project, '../a.md')).toBeNull();
    expect(workspaceRecentFile({ ...project, capabilities: { files: false } }, 'a.md')).toBeNull();
    localStorage.setItem('pilotdeck:recent-files:v1:invalid', JSON.stringify([
      { projectName: 'one', path: '../a.md', visitedAt: 1 }, { projectName: 'one', path: '/a.md', visitedAt: 1 },
      { projectName: 'one', path: 'a.md', visitedAt: 'invalid' },
    ]));
    expect(readRecentFiles('invalid')).toEqual([]);
  });

  it('deduplicates Windows aliases while preserving filename spelling', () => {
    const project = { name: 'windows', displayName: 'Windows', fullPath: 'C:\\Work\\PilotDeck' };
    recordRecentFile('alice', workspaceRecentFile(project, 'C:\\Work\\PilotDeck\\Docs\\Guide.MD', 1)!);
    recordRecentFile('alice', workspaceRecentFile(project, 'docs/Guide.MD', 2)!);
    expect(readRecentFiles('alice')).toEqual([{ projectName: 'windows', path: 'docs/Guide.MD', identityPath: 'docs/guide.md', visitedAt: 2 }]);
  });

  it('keeps accumulating visits in memory when persistent storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    recordRecentFile('no-storage', { projectName: 'one', path: 'a.md', visitedAt: 1 });
    recordRecentFile('no-storage', { projectName: 'one', path: 'b.md', visitedAt: 2 });
    expect(readRecentFiles('no-storage').map(file => file.path)).toEqual(['b.md', 'a.md']);
  });
});
