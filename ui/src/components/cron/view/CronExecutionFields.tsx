import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../../../types/app';
import { api } from '../../../utils/api';

export type CronExecutionDraft = {
  notificationPolicy: 'all' | 'findings' | 'failures';
  mode: 'default' | 'bypassPermissions';
  workspaceMode: 'local' | 'worktree';
  modelSelection?: { provider: string; model: string };
};
type Model = { provider: string; model: string; displayName: string; available: boolean };

export default function CronExecutionFields({ value, onChange, project }: {
  value: CronExecutionDraft; onChange: (value: CronExecutionDraft) => void; project?: Project;
}) {
  const { t } = useTranslation(['alwaysOn', 'chat']);
  const configured = value.notificationPolicy !== 'all' || value.mode !== 'default' || value.workspaceMode !== 'local' || Boolean(value.modelSelection);
  const [expanded, setExpanded] = useState(configured);
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setModels([]); setError('');
    if (!project || typeof api.cronOptions !== 'function') return;
    void api.cronOptions(project.fullPath).then(async (response: Response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load execution options.');
      if (!disposed) setModels(data.models || []);
    }).catch((caught: unknown) => { if (!disposed) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { disposed = true; };
  }, [project?.fullPath]);
  const update = (patch: Partial<CronExecutionDraft>) => onChange({ ...value, ...patch });
  return <details className="cron-editor-advanced" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t('cron.execution.advanced')}{configured && <span>{t('cron.workspace.customized')}</span>}</summary>
    <div className="space-y-4 pt-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-[13px]">{t('cron.execution.notifications')}
          <select className="pd-form-field mt-1.5" value={value.notificationPolicy} onChange={event => update({ notificationPolicy: event.target.value as CronExecutionDraft['notificationPolicy'] })}>
            <option value="all">{t('cron.execution.all')}</option><option value="findings">{t('cron.execution.findings')}</option><option value="failures">{t('cron.execution.failures')}</option>
          </select>
        </label>
        <label className="text-[13px]">{t('cron.execution.permissions')}
          <select className="pd-form-field mt-1.5" value={value.mode} onChange={event => update({ mode: event.target.value as CronExecutionDraft['mode'] })}>
            <option value="default">{t('chat:input.permissions.default')}</option>
            <option value="bypassPermissions">{t('chat:input.permissions.bypassPermissions')}</option>
          </select>
        </label>
        <label className="text-[13px]">{t('cron.execution.workspace')}
          <select className="pd-form-field mt-1.5" value={value.workspaceMode} onChange={event => update({ workspaceMode: event.target.value as CronExecutionDraft['workspaceMode'] })}>
            <option value="local">{t('cron.execution.local')}</option><option value="worktree">{t('cron.execution.worktree')}</option>
          </select>
        </label>
        <label className="text-[13px]">{t('cron.execution.model')}
          <select className="pd-form-field mt-1.5" value={value.modelSelection ? JSON.stringify(value.modelSelection) : ''} onChange={event => update({ modelSelection: event.target.value ? JSON.parse(event.target.value) : undefined })}>
            <option value="">{t('cron.execution.defaultModel')}</option>
            {models.filter(model => model.available && model.provider && model.model).map(model => <option key={`${model.provider}/${model.model}`} value={JSON.stringify({ provider: model.provider, model: model.model })}>{model.displayName || model.model}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="text-xs text-amber-600">{error}</p>}
    </div>
  </details>;
}
