import type { ChatFileArtifact } from '../chat/types/types';
import type { Project } from '../../types/app';
import { canonicalizeWorkspaceFilePath, getWorkspaceFileIdentity } from '../../utils/workspaceFileMention';
import type { CheckpointSummary } from './ChatReviewContext';
import { visibleReviewFiles } from './reviewFiles';

export type TurnFile = {
  key: string;
  path: string;
  name: string;
  directory: string;
  artifact?: ChatFileArtifact;
  change?: CheckpointSummary['changes'][number];
};

// Both records describe the same result. Checkpoints own change semantics;
// artifacts supply file metadata and existing workspace actions.
export function mergeTurnFiles(artifacts: ChatFileArtifact[], checkpoint: CheckpointSummary | undefined, project: Project | null): TurnFile[] {
  const root = project?.fullPath || project?.path || '';
  const files = new Map<string, TurnFile>();
  const entry = (path: string) => {
    const key = getWorkspaceFileIdentity(path, root);
    const relative = canonicalizeWorkspaceFilePath(path, root);
    const segments = relative.split('/');
    const file = files.get(key) ?? { key, path: relative, name: segments.at(-1) || relative, directory: segments.slice(0, -1).join('/') };
    files.set(key, file);
    return file;
  };
  for (const artifact of visibleReviewFiles(artifacts, root)) entry(artifact.path).artifact = artifact;
  for (const change of visibleReviewFiles(checkpoint?.changes ?? [], root)) entry(change.path).change = change;
  return [...files.values()];
}

export function isPreviewFile(path: string, binary?: boolean): boolean {
  return Boolean(binary) || /\.(?:pdf|docx?|pptx?|xlsx?|ods|odt|odp|png|jpe?g|gif|webp|svg|bmp|ico|mp4|mov|webm|mp3|wav|ogg)$/i.test(path);
}

export function formatFileSize(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
