import { getWorkspaceFileIdentity } from '../../utils/workspaceFileMention';

// Presentation only: keep the original checkpoint and restore plan intact.
export function isInternalReviewPath(path: string, workspaceRoot = ''): boolean {
  return getWorkspaceFileIdentity(path, workspaceRoot).split('/').includes('.pilotdeck');
}

export function visibleReviewFiles<T extends { path: string }>(files: readonly T[], workspaceRoot = ''): T[] {
  return files.filter(file => !isInternalReviewPath(file.path, workspaceRoot));
}
