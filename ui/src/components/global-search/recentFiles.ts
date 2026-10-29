import type { Project } from '../../types/app';
import { getWorkspaceFileIdentity, getWorkspaceRelativePath } from '../../utils/workspaceFileMention';

export type RecentFile = { projectName: string; path: string; visitedAt: number; identityPath?: string };
export type RecentFileIdentity = Pick<RecentFile, 'projectName' | 'path' | 'identityPath'>;
const LIMIT = 50;
const storageKey = (userKey: string) => 'pilotdeck:recent-files:v1:' + encodeURIComponent(userKey);
const identity = (file: RecentFileIdentity) => JSON.stringify([file.projectName, file.identityPath || file.path]);
const memoryOnly = new Map<string, RecentFile[]>();

export function readRecentFiles(userKey: string): RecentFile[] {
  const fallback = memoryOnly.get(userKey);
  if (fallback) return fallback;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey(userKey)) || '[]');
    if (!Array.isArray(raw)) return [];
    const valid = raw.filter((file): file is RecentFile => Boolean(file && typeof file.projectName === 'string'
      && typeof file.path === 'string' && file.path && getWorkspaceRelativePath(file.path, '/') === file.path
      && Number.isFinite(file.visitedAt) && file.visitedAt > 0
      && (file.identityPath === undefined || file.identityPath === file.path || file.identityPath === file.path.toLowerCase())));
    const unique = new Map<string, RecentFile>();
    for (const file of valid.sort((a, b) => b.visitedAt - a.visitedAt)) if (!unique.has(identity(file))) unique.set(identity(file), file);
    const files = [...unique.values()].slice(0, LIMIT);
    return files;
  } catch { return []; }
}

function save(userKey: string, files: RecentFile[]) {
  try {
    localStorage.setItem(storageKey(userKey), JSON.stringify(files));
    memoryOnly.delete(userKey);
  } catch { memoryOnly.set(userKey, files); }
  return files;
}

export function recordRecentFile(userKey: string, file: RecentFile): RecentFile[] {
  const previous = readRecentFiles(userKey);
  const existing = previous.find(item => identity(item) === identity(file));
  if (existing && existing.visitedAt > file.visitedAt) return previous;
  return save(userKey, [file, ...previous.filter(item => identity(item) !== identity(file))]
    .sort((a, b) => b.visitedAt - a.visitedAt).slice(0, LIMIT));
}

export function forgetRecentFiles(userKey: string, files: RecentFileIdentity[]) {
  const remove = new Set(files.map(identity));
  return save(userKey, readRecentFiles(userKey).filter(file => !remove.has(identity(file))));
}

export function workspaceRecentFile(project: Project, path: string, visitedAt = Date.now()): RecentFile | null {
  const root = project.fullPath || project.path || '';
  if (!project.name || !root || project.capabilities?.files === false) return null;
  const relative = getWorkspaceRelativePath(path, root);
  if (!relative) return null;
  return { projectName: project.name, path: relative, identityPath: getWorkspaceFileIdentity(relative, root), visitedAt };
}

export const isRecentFilesStorageKey = (key: string | null, userKey: string) => key === null || key === storageKey(userKey);
