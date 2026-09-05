import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import FolderBrowserModal from '../../../project-creation-wizard/components/FolderBrowserModal';
import GithubAuthenticationCard from '../../../project-creation-wizard/components/GithubAuthenticationCard';
import { useGithubTokens } from '../../../project-creation-wizard/hooks/useGithubTokens';
import { shouldShowGithubAuthentication } from '../../../project-creation-wizard/utils/pathUtils';
import type { TokenMode } from '../../../project-creation-wizard/types';
import type { WorkspaceDraft } from '../types';
import { ArrowLeftIcon, FolderBrowseIcon, StepCheckIcon } from './icons';

type WorkspaceStepBaseProps = {
  draft: WorkspaceDraft;
  error: string;
  progress: string;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedGithubTokenChange: (tokenId: string) => void;
  onNewGithubTokenChange: (token: string) => void;
  onFinish: () => void | Promise<void>;
};

export type WorkspaceStepProps = WorkspaceStepBaseProps & (
  | {
      variant?: 'onboarding';
      onBack: () => void;
      onSkipChat: () => void | Promise<void>;
      onCancel?: never;
    }
  | {
      variant: 'dialog';
      onCancel: () => void;
      onBack?: never;
      onSkipChat?: never;
    }
);

export default function WorkspaceStep(props: WorkspaceStepProps) {
  const {
    draft,
    error,
    progress,
    isCreating,
    onWorkspacePathChange,
    onGithubUrlChange,
    onTokenModeChange,
    onSelectedGithubTokenChange,
    onNewGithubTokenChange,
    onFinish,
  } = props;
  const isDialog = props.variant === 'dialog';
  const { t } = useTranslation('onboarding');
  const { t: tCommon } = useTranslation();
  const [pathInvalid, setPathInvalid] = useState(false);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const showGithubAuthentication = shouldShowGithubAuthentication(
    draft.workspaceType,
    draft.githubUrl,
  );
  const handleAutoSelectToken = useCallback((tokenId: string) => {
    onSelectedGithubTokenChange(tokenId);
    onTokenModeChange('stored');
  }, [onSelectedGithubTokenChange, onTokenModeChange]);
  const { tokens, loading: loadingTokens, loadError: tokenLoadError } = useGithubTokens({
    shouldLoad: showGithubAuthentication,
    selectedTokenId: draft.selectedGithubToken,
    onAutoSelectToken: handleAutoSelectToken,
  });

  const handlePathChange = (value: string) => {
    setPathInvalid(false);
    onWorkspacePathChange(value);
  };

  const handleBrowseFolder = async () => {
    if (isCreating || isPickingFolder) return;
    setIsPickingFolder(true);
    setBrowseError('');
    try {
      if (window.pilotdeckDesktop?.pickFolder) {
        const selectedPath = await window.pilotdeckDesktop.pickFolder();
        if (selectedPath) handlePathChange(selectedPath);
      } else {
        setShowFolderBrowser(true);
      }
    } catch (caughtError) {
      setBrowseError(
        caughtError instanceof Error ? caughtError.message : String(caughtError),
      );
    } finally {
      setIsPickingFolder(false);
    }
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
        <h1 id={isDialog ? 'create-workspace-dialog-title' : undefined}>{t('workspace.title')}</h1>
        <p className="intro-copy">
          {isDialog ? t('workspace.dialogIntro') : t('workspace.intro')}
        </p>
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
                onClick={() => {
                  void handleBrowseFolder();
                }}
                disabled={isCreating || isPickingFolder}
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
              placeholder={t('workspace.githubPlaceholder')}
              disabled={isCreating}
            />
            <small>{t('workspace.githubHint')}</small>
          </span>
        </label>
        {showGithubAuthentication ? (
          <GithubAuthenticationCard
            tokenMode={draft.tokenMode}
            selectedGithubToken={draft.selectedGithubToken}
            newGithubToken={draft.newGithubToken}
            availableTokens={tokens}
            loadingTokens={loadingTokens}
            tokenLoadError={tokenLoadError}
            onTokenModeChange={onTokenModeChange}
            onSelectedGithubTokenChange={onSelectedGithubTokenChange}
            onNewGithubTokenChange={onNewGithubTokenChange}
          />
        ) : null}
      </form>

      {(error || progress || browseError) && (
        <div className={error || browseError ? 'workspace-error' : 'field-help'}>
          {error || browseError || progress}
        </div>
      )}

      <div className="footer-actions workspace-create-actions">
        {isDialog ? (
          <button
            className="button secondary"
            type="button"
            onClick={props.onCancel}
            disabled={isCreating}
          >
            {tCommon('buttons.cancel')}
          </button>
        ) : (
          <button
            className="button secondary"
            type="button"
            onClick={props.onBack}
            disabled={isCreating}
          >
            <ArrowLeftIcon width={18} height={18} />
            {t('actions.back')}
          </button>
        )}
        <div className="workspace-primary-actions">
          {isDialog ? null : (
            <button
              className="button secondary direct-chat-button"
              type="button"
              onClick={() => {
                void props.onSkipChat();
              }}
              disabled={isCreating}
            >
              {t('workspace.startChatting')}
            </button>
          )}
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
        autoAdvanceOnSelect={false}
        onClose={() => setShowFolderBrowser(false)}
        onFolderSelected={(selectedPath) => {
          handlePathChange(selectedPath);
          setShowFolderBrowser(false);
        }}
      />
    </div>
  );
}
