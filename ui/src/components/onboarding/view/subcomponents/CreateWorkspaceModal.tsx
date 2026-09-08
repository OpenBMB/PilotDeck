import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import useOnboardingWorkspace from '../hooks/useOnboardingWorkspace';
import { CloseIcon } from './icons';
import WorkspaceStep from './WorkspaceStep';
import '../Onboarding.css';

type CreateWorkspaceModalProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

export default function CreateWorkspaceModal({
  onClose,
  onProjectCreated,
}: CreateWorkspaceModalProps) {
  const { t } = useTranslation();
  const {
    draft,
    error,
    progress,
    isCreating,
    setWorkspacePath,
    setGithubUrl,
    setTokenMode,
    setSelectedGithubToken,
    setNewGithubToken,
    createWorkspace,
  } = useOnboardingWorkspace();

  const handleFinish = useCallback(async () => {
    try {
      const project = await createWorkspace();
      onProjectCreated?.(project);
    } catch {
      /* error is surfaced by the workspace form */
    }
  }, [createWorkspace, onProjectCreated]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isCreating) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isCreating, onClose]);

  return (
    <div className="create-workspace-dialog-overlay">
      <div
        className="onboarding-shell create-workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-workspace-dialog-title"
      >
        <button
          type="button"
          className="create-workspace-dialog-close"
          aria-label={t('buttons.close')}
          onClick={onClose}
          disabled={isCreating}
        >
          <CloseIcon width={16} height={16} />
        </button>
        <WorkspaceStep
          variant="dialog"
          draft={draft}
          error={error}
          progress={progress}
          isCreating={isCreating}
          onWorkspacePathChange={setWorkspacePath}
          onGithubUrlChange={setGithubUrl}
          onTokenModeChange={setTokenMode}
          onSelectedGithubTokenChange={setSelectedGithubToken}
          onNewGithubTokenChange={setNewGithubToken}
          onCancel={onClose}
          onFinish={handleFinish}
        />
      </div>
    </div>
  );
}
