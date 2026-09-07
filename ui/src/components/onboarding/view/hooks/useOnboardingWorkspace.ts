import { useCallback, useRef, useState } from 'react';
import {
  cloneWorkspaceWithProgress,
  createWorkspaceRequest,
} from '../../../project-creation-wizard/data/workspaceApi';
import {
  isCloneWorkflow,
  shouldShowGithubAuthentication,
} from '../../../project-creation-wizard/utils/pathUtils';
import type { WorkspaceType } from '../../../project-creation-wizard/types';
import type { WorkspaceDraft } from '../types';

const initialDraft: WorkspaceDraft = {
  workspaceType: 'new',
  workspacePath: '',
  githubUrl: '',
  tokenMode: 'none',
  selectedGithubToken: '',
  newGithubToken: '',
};

export default function useOnboardingWorkspace() {
  const [draft, setDraft] = useState<WorkspaceDraft>(initialDraft);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const createdDraftsRef = useRef(new Set<string>());
  const inFlightRef = useRef<{
    fingerprint: string;
    promise: Promise<Record<string, unknown> | undefined>;
  } | null>(null);

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

  const setTokenMode = useCallback((tokenMode: WorkspaceDraft['tokenMode']) => {
    setDraft((current) => ({ ...current, tokenMode }));
    setError('');
  }, []);

  const setSelectedGithubToken = useCallback((selectedGithubToken: string) => {
    setDraft((current) => ({ ...current, selectedGithubToken }));
    setError('');
  }, []);

  const setNewGithubToken = useCallback((newGithubToken: string) => {
    setDraft((current) => ({ ...current, newGithubToken }));
    setError('');
  }, []);

  const canFinish = draft.workspacePath.trim().length > 0;

  const createWorkspace = useCallback(async () => {
    const workspacePath = draft.workspacePath.trim();
    const githubUrl = draft.githubUrl.trim();
    if (!workspacePath) {
      throw new Error('Workspace path is required.');
    }
    const fingerprint = JSON.stringify({ workspacePath, githubUrl });
    if (createdDraftsRef.current.has(fingerprint)) return;
    if (inFlightRef.current?.fingerprint === fingerprint) {
      return inFlightRef.current.promise;
    }

    setIsCreating(true);
    setError('');
    setProgress('');
    const useGithubAuthentication = shouldShowGithubAuthentication('new', githubUrl);

    const operation = isCloneWorkflow('new', githubUrl)
      ? cloneWorkspaceWithProgress(
          {
            workspacePath,
            githubUrl,
            tokenMode: useGithubAuthentication ? draft.tokenMode : 'none',
            selectedGithubToken: useGithubAuthentication ? draft.selectedGithubToken : '',
            newGithubToken: useGithubAuthentication ? draft.newGithubToken : '',
          },
          { onProgress: setProgress },
        )
      : createWorkspaceRequest({
          workspaceType: 'new',
          path: workspacePath,
        });
    inFlightRef.current = { fingerprint, promise: operation };

    try {
      const result = await operation;
      createdDraftsRef.current.add(fingerprint);
      return result;
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to create workspace';
      setError(message);
      throw caughtError;
    } finally {
      if (inFlightRef.current?.promise === operation) inFlightRef.current = null;
      setIsCreating(false);
    }
  }, [draft.githubUrl, draft.newGithubToken, draft.selectedGithubToken, draft.tokenMode, draft.workspacePath]);

  return {
    draft,
    isCreating,
    error,
    progress,
    canFinish,
    setWorkspaceType,
    setWorkspacePath,
    setGithubUrl,
    setTokenMode,
    setSelectedGithubToken,
    setNewGithubToken,
    createWorkspace,
  };
}
