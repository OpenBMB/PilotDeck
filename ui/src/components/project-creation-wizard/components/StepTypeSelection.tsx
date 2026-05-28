import { FolderPlus, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceType } from '../types';

type StepTypeSelectionProps = {
  workspaceType: WorkspaceType;
  onWorkspaceTypeChange: (workspaceType: WorkspaceType) => void;
};

export default function StepTypeSelection({
  workspaceType,
  onWorkspaceTypeChange,
}: StepTypeSelectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <h4 className="mb-3 text-sm font-medium text-muted-foreground">
        {t('projectWizard.step1.question')}
      </h4>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <button
          onClick={() => onWorkspaceTypeChange('existing')}
          className={`rounded-lg border p-4 text-left transition-colors ${
            workspaceType === 'existing'
              ? 'border-foreground bg-accent/50'
              : 'border-border hover:bg-accent/30'
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
              <FolderPlus className="h-5 w-5" strokeWidth={1.75} />
            </div>
            <div className="flex-1">
              <h5 className="mb-1 font-semibold text-foreground">
                {t('projectWizard.step1.existing.title')}
              </h5>
              <p className="text-sm text-muted-foreground">
                {t('projectWizard.step1.existing.description')}
              </p>
            </div>
          </div>
        </button>

        <button
          onClick={() => onWorkspaceTypeChange('new')}
          className={`rounded-lg border p-4 text-left transition-colors ${
            workspaceType === 'new'
              ? 'border-foreground bg-accent/50'
              : 'border-border hover:bg-accent/30'
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
              <GitBranch className="h-5 w-5" strokeWidth={1.75} />
            </div>
            <div className="flex-1">
              <h5 className="mb-1 font-semibold text-foreground">
                {t('projectWizard.step1.new.title')}
              </h5>
              <p className="text-sm text-muted-foreground">
                {t('projectWizard.step1.new.description')}
              </p>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
