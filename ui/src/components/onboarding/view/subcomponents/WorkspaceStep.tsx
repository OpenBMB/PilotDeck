import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import FolderBrowserModal from '../../../project-creation-wizard/components/FolderBrowserModal';
import type { WorkspaceType } from '../../../project-creation-wizard/types';
import type { WorkspaceDraft } from '../types';
import FooterActions from './FooterActions';
import { FolderBrowseIcon, FolderIcon, GitBranchIcon, RadioCheckIcon } from './icons';

type WorkspaceStepProps = {
  draft: WorkspaceDraft;
  error: string;
  progress: string;
  isCreating: boolean;
  canFinish: boolean;
  onWorkspaceTypeChange: (workspaceType: WorkspaceType) => void;
  onWorkspacePathChange: (workspacePath: string) => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onBack: () => void;
  onFinish: () => void | Promise<void>;
};

export default function WorkspaceStep({
  draft,
  error,
  progress,
  isCreating,
  canFinish,
  onWorkspaceTypeChange,
  onWorkspacePathChange,
  onGithubUrlChange,
  onBack,
  onFinish,
}: WorkspaceStepProps) {
  const { t } = useTranslation('onboarding');
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  return (
    <div className="content-page workspace-setup-page">
      <header className="page-intro">
        <h1>{t('workspace.title')}</h1>
        <p className="intro-copy">{t('workspace.intro')}</p>
      </header>

      <section className="workspace-type-section">
        <h2>{t('workspace.typeHeading')}</h2>
        <div className="workspace-type-grid">
          <button
            className={`workspace-type-card${draft.workspaceType === 'existing' ? ' selected' : ''}`}
            type="button"
            aria-pressed={draft.workspaceType === 'existing'}
            onClick={() => onWorkspaceTypeChange('existing')}
          >
            <span className="workspace-type-icon"><FolderIcon /></span>
            <span>
              <strong>{t('workspace.existingTitle')}</strong>
              <small>{t('workspace.existingHint')}</small>
            </span>
            <span className="radio-dot" aria-hidden="true">
              {draft.workspaceType === 'existing' && <RadioCheckIcon />}
            </span>
          </button>
          <button
            className={`workspace-type-card${draft.workspaceType === 'new' ? ' selected' : ''}`}
            type="button"
            aria-pressed={draft.workspaceType === 'new'}
            onClick={() => onWorkspaceTypeChange('new')}
          >
            <span className="workspace-type-icon"><GitBranchIcon /></span>
            <span>
              <strong>{t('workspace.newTitle')}</strong>
              <small>{t('workspace.newHint')}</small>
            </span>
            <span className="radio-dot" aria-hidden="true">
              {draft.workspaceType === 'new' && <RadioCheckIcon />}
            </span>
          </button>
        </div>
      </section>

      <div className="workspace-config-card">
        <label className="field-group">
          {t('workspace.pathLabel')}
          <div className="workspace-path-control">
            <input
              type="text"
              value={draft.workspacePath}
              onChange={(event) => onWorkspacePathChange(event.target.value)}
              placeholder={draft.workspaceType === 'existing' ? '/path/to/existing/workspace' : '/path/to/new/workspace'}
              disabled={isCreating}
            />
            <button
              className="folder-browse-button"
              type="button"
              title={t('workspace.browse')}
              onClick={() => setShowFolderBrowser(true)}
              disabled={isCreating}
            >
              <FolderBrowseIcon />
            </button>
          </div>
          <small>{t('workspace.pathHint')}</small>
        </label>

        {draft.workspaceType === 'new' && (
          <label className="field-group">
            {t('workspace.githubLabel')}
            <div className="github-url-control">
              <input
                type="url"
                value={draft.githubUrl}
                onChange={(event) => onGithubUrlChange(event.target.value)}
                placeholder={t('workspace.githubPlaceholder')}
                disabled={isCreating}
              />
            </div>
            <small>{t('workspace.githubHint')}</small>
          </label>
        )}

        {(error || progress) && (
          <div className={error ? 'workspace-error' : 'field-help'}>
            {error || progress}
          </div>
        )}
      </div>

      <FooterActions
        backLabel={t('actions.back')}
        nextLabel={t('actions.finish')}
        nextDisabled={!canFinish}
        nextBusy={isCreating}
        onBack={onBack}
        onNext={() => {
          void onFinish();
        }}
      />

      <FolderBrowserModal
        isOpen={showFolderBrowser}
        autoAdvanceOnSelect={draft.workspaceType === 'existing'}
        onClose={() => setShowFolderBrowser(false)}
        onFolderSelected={(selectedPath) => {
          onWorkspacePathChange(selectedPath);
          setShowFolderBrowser(false);
        }}
      />
    </div>
  );
}
