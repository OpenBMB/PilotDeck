import { useCallback, useState } from 'react';
import {
  cloneWorkspaceWithProgress,
  createWorkspaceRequest,
} from '../../../project-creation-wizard/data/workspaceApi';
import { isCloneWorkflow } from '../../../project-creation-wizard/utils/pathUtils';
import type { WorkspaceType } from '../../../project-creation-wizard/types';
import type { WorkspaceDraft } from '../types';

const initialDraft: WorkspaceDraft = {
  workspaceType: 'existing',
  workspacePath: '',
  githubUrl: '',
};

export default function useOnboardingWorkspace() {
  const [draft, setDraft] = useState<WorkspaceDraft>(initialDraft);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');

  const setWorkspaceType = useCallback((workspaceType: WorkspaceType) => {
    setDraft((current) => ({ ...current, workspaceType }));
    setError('');
  }, []);

  const setWorkspacePath = useCallback((workspacePath: string) => {
    setDraft((current) => ({ ...current, workspacePath }));
    setError('');
  }, []);

  const setGithubUrl = useCallback((githubUrl: string) => {
    setDraft((current) => ({ ...current, githubUrl }));
    setError('');
  }, []);

  const canFinish = draft.workspacePath.trim().length > 0;

  const createWorkspace = useCallback(async () => {
    if (!canFinish) return;
    setIsCreating(true);
    setError('');
    setProgress('');

    try {
      if (isCloneWorkflow(draft.workspaceType, draft.githubUrl)) {
        await cloneWorkspaceWithProgress(
          {
            workspacePath: draft.workspacePath.trim(),
            githubUrl: draft.githubUrl.trim(),
            tokenMode: 'none',
            selectedGithubToken: '',
            newGithubToken: '',
          },
          { onProgress: setProgress },
        );
        return;
      }

      await createWorkspaceRequest({
        workspaceType: draft.workspaceType,
        path: draft.workspacePath.trim(),
      });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to create workspace';
      setError(message);
      throw caughtError;
    } finally {
      setIsCreating(false);
    }
  }, [canFinish, draft.githubUrl, draft.workspacePath, draft.workspaceType]);

  return {
    draft,
    isCreating,
    error,
    progress,
    canFinish,
    setWorkspaceType,
    setWorkspacePath,
    setGithubUrl,
    createWorkspace,
  };
}
