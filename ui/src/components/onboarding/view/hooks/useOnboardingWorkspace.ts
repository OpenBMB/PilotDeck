import { useCallback, useState } from 'react';
import {
  cloneWorkspaceWithProgress,
  createWorkspaceRequest,
} from '../../../project-creation-wizard/data/workspaceApi';
import { isCloneWorkflow } from '../../../project-creation-wizard/utils/pathUtils';
import type { WorkspaceType } from '../../../project-creation-wizard/types';
import type { WorkspaceDraft } from '../types';

const initialDraft: WorkspaceDraft = {
  workspaceType: 'new',
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
    if (!draft.workspacePath.trim()) {
      throw new Error('Workspace path is required.');
    }
    setIsCreating(true);
    setError('');
    setProgress('');

    try {
      if (isCloneWorkflow('new', draft.githubUrl)) {
        return await cloneWorkspaceWithProgress(
          {
            workspacePath: draft.workspacePath.trim(),
            githubUrl: draft.githubUrl.trim(),
            tokenMode: 'none',
            selectedGithubToken: '',
            newGithubToken: '',
          },
          { onProgress: setProgress },
        );
      }

      return await createWorkspaceRequest({
        workspaceType: 'new',
        path: draft.workspacePath.trim(),
      });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to create workspace';
      setError(message);
      throw caughtError;
    } finally {
      setIsCreating(false);
    }
  }, [draft.githubUrl, draft.workspacePath]);

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
