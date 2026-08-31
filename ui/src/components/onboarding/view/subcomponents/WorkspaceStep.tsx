import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import FolderBrowserModal from '../../../project-creation-wizard/components/FolderBrowserModal';
import type { WorkspaceDraft } from '../types';
import { ArrowLeftIcon, FolderBrowseIcon, StepCheckIcon } from './icons';

type WorkspaceStepProps = {
  draft: WorkspaceDraft;
  error: string;
  progress: string;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onBack: () => void;
  onSkipChat: () => void | Promise<void>;
  onFinish: () => void | Promise<void>;
};

export default function WorkspaceStep({
  draft,
  error,
  progress,
  isCreating,
  onWorkspacePathChange,
  onGithubUrlChange,
  onBack,
  onSkipChat,
  onFinish,
}: WorkspaceStepProps) {
  const { t } = useTranslation('onboarding');
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [pathInvalid, setPathInvalid] = useState(false);

  const handlePathChange = (value: string) => {
    setPathInvalid(false);
    onWorkspacePathChange(value);
  };

  const handleCreateWorkspace = () => {
    if (!draft.workspacePath.trim()) {
      setPathInvalid(true);
      return;
    }
    void onFinish();
  };

  return (
    <div className="content-page workspace-setup-page">
      <header className="page-intro">
        <h1>{t('workspace.title')}</h1>
        <p className="intro-copy">{t('workspace.intro')}</p>
      </header>

      <form className="workspace-simple-form" onSubmit={(event) => event.preventDefault()}>
        <label className={`workspace-form-row${pathInvalid ? ' invalid' : ''}`}>
          <span>{t('workspace.pathLabel')}</span>
          <span className="workspace-field-stack workspace-path-field-stack">
            <span className="workspace-path-control">
              <input
                type="text"
                value={draft.workspacePath}
                onChange={(event) => handlePathChange(event.target.value)}
                aria-invalid={pathInvalid}
                aria-required="true"
                disabled={isCreating}
              />
              <button
                type="button"
                className="folder-browse-button"
                aria-label={t('workspace.browse')}
                title={t('workspace.browse')}
                onClick={() => setShowFolderBrowser(true)}
                disabled={isCreating}
              >
                <FolderBrowseIcon width={20} height={20} />
              </button>
            </span>
            <small className="workspace-name-help">
              {pathInvalid ? t('workspace.pathRequired') : t('workspace.pathHint')}
            </small>
          </span>
        </label>
        <label className="workspace-form-row github-url-field">
          <span>{t('workspace.githubLabel')}</span>
          <span className="workspace-field-stack">
            <input
              type="url"
              value={draft.githubUrl}
              onChange={(event) => onGithubUrlChange(event.target.value)}
              disabled={isCreating}
            />
            <small>{t('workspace.githubHint')}</small>
          </span>
        </label>
      </form>

      {(error || progress) && (
        <div className={error ? 'workspace-error' : 'field-help'}>
          {error || progress}
        </div>
      )}

      <div className="footer-actions workspace-create-actions">
        <button className="button secondary" type="button" onClick={onBack} disabled={isCreating}>
          <ArrowLeftIcon width={18} height={18} />
          {t('actions.back')}
        </button>
        <div className="workspace-primary-actions">
          <button
            className="button secondary direct-chat-button"
            type="button"
            onClick={() => {
              void onSkipChat();
            }}
            disabled={isCreating}
          >
            {t('workspace.startChatting')}
          </button>
          <button
            className="button primary"
            type="button"
            onClick={handleCreateWorkspace}
            disabled={isCreating}
          >
            <StepCheckIcon width={18} height={18} />
            {t('workspace.createWorkspace')}
          </button>
        </div>
      </div>

      <FolderBrowserModal
        isOpen={showFolderBrowser}
        autoAdvanceOnSelect
        onClose={() => setShowFolderBrowser(false)}
        onFolderSelected={(selectedPath) => {
          handlePathChange(selectedPath);
          setShowFolderBrowser(false);
        }}
      />
    </div>
  );
}
