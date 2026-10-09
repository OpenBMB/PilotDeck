import { useTranslation } from 'react-i18next';
import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { ADD_WORKSPACE_FILE_MENTION_EVENT, getWorkspaceRelativePath } from '../../utils/workspaceFileMention';
import { useConfirm } from '../ui/ConfirmDialog';

export type WorkspaceFileTarget = {
  name: string;
  path: string;
  sha256?: string;
  workspaceBacked?: boolean;
};

export function useWorkspaceFileActions(file: WorkspaceFileTarget, project: Project | null, onBrowse?: (path: string) => void, verifyVersion = true) {
  const { t } = useTranslation('chat');
  const confirm = useConfirm();
  const root = project?.fullPath || project?.path || '';
  const relativePath = file.workspaceBacked === false ? null : root ? getWorkspaceRelativePath(file.path, root) : file.path.replace(/^\.\//, '') || null;
  const canBrowse = Boolean(onBrowse && file.workspaceBacked !== false);
  const canUseWorkspaceActions = Boolean(project?.name && relativePath);
  const browse = async () => {
    if (!canBrowse || !onBrowse) return;
    if (verifyVersion && project?.name && relativePath && file.sha256) {
      try {
        const response = await api.fileContentSha256(project.name, relativePath);
        const currentHash = response.headers.get('X-PilotDeck-Content-SHA256');
        if (response.ok && currentHash && currentHash !== file.sha256 && !await confirm({
          message: t('fileArtifacts.updatedSinceMessage', { defaultValue: 'This file has changed since this message. Open the current version?' }) as string,
          confirmLabel: t('common:confirmDialog.open'),
        })) return;
      } catch {
        // The file preview reports missing or inaccessible files.
      }
    }
    onBrowse(relativePath || file.path);
  };
  const download = () => {
    if (!project?.name || !relativePath) return;
    const anchor = document.createElement('a');
    anchor.href = api.fileDownloadUrl(project.name, relativePath);
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };
  const reference = () => {
    if (!project?.name || !relativePath) return;
    window.dispatchEvent(new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, { detail: { projectName: project.name, relativePath } }));
  };
  return { canBrowse, canUseWorkspaceActions, browse, download, reference };
}
