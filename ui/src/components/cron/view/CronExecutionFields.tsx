import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../../../types/app';
import { api } from '../../../utils/api';

export type CronExecutionDraft = {
  executionMode: 'independent' | 'conversation' | 'persistent';
  sessionKey: string;
  notificationPolicy: 'all' | 'findings' | 'failures';
  mode: 'default' | 'plan' | 'bypassPermissions';
  workspaceMode: 'local' | 'worktree';
  modelSelection?: { provider: string; model: string };
};

type Options = { sessions: Array<{ id: string; title?: string; summary?: string }>; models: Array<{ provider: string; model: string; displayName: string; available: boolean }> };

export default function CronExecutionFields({ value, onChange, project, editing }: {
  value: CronExecutionDraft; onChange: (value: CronExecutionDraft) => void; project?: Project; editing: boolean;
}) {
  const { t } = useTranslation('alwaysOn');
  const [expanded, setExpanded] = useState(value.executionMode !== 'independent' || value.notificationPolicy !== 'all' || value.mode !== 'default' || value.workspaceMode !== 'local' || Boolean(value.modelSelection));
  const [options, setOptions] = useState<Options>({ sessions: [], models: [] });
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setOptions({ sessions: [], models: [] });
    setError('');
    if (!project || typeof api.cronOptions !== 'function') return;
    void api.cronOptions(project.fullPath).then(async (response: Response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load execution options.');
      if (!disposed) setOptions(data);
    }).catch((caught: unknown) => { if (!disposed) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { disposed = true; };
  }, [project?.fullPath]);
  const update = (patch: Partial<CronExecutionDraft>) => onChange({ ...value, ...patch });
  const sessions = options.sessions.length ? options.sessions : project?.sessions ?? [];
  const configured = value.executionMode !== 'independent' || value.notificationPolicy !== 'all' || value.mode !== 'default' || value.workspaceMode !== 'local' || Boolean(value.modelSelection);
  return <details className="cron-editor-advanced" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t('cron.execution.advanced', { defaultValue: 'Advanced execution settings' })}{configured && <span>{t('cron.workspace.customized', { defaultValue: 'Customized' })}</span>}</summary>
    <div className="space-y-4 pt-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-[13px]">{t('cron.execution.context', { defaultValue: 'Conversation context' })}
        <select className="pd-form-field mt-1.5" value={value.executionMode} onChange={event => update({ executionMode: event.target.value as CronExecutionDraft['executionMode'], ...(event.target.value !== 'independent' ? { workspaceMode: 'local' as const } : {}) })}>
          <option value="independent">{t('cron.execution.independent', { defaultValue: 'New conversation for each run' })}</option>
          <option value="conversation">{t('cron.execution.conversation', { defaultValue: 'Continue an existing conversation' })}</option>
          <option value="persistent">{t('cron.execution.persistent', { defaultValue: 'Reuse a dedicated task conversation' })}</option>
        </select>
      </label>
      <label className="text-[13px]">{t('cron.execution.notifications', { defaultValue: 'Result notifications' })}
        <select className="pd-form-field mt-1.5" value={value.notificationPolicy} onChange={event => update({ notificationPolicy: event.target.value as CronExecutionDraft['notificationPolicy'] })}>
          <option value="all">{t('cron.execution.all', { defaultValue: 'Every run' })}</option>
          <option value="findings">{t('cron.execution.findings', { defaultValue: 'New findings or failures' })}</option>
          <option value="failures">{t('cron.execution.failures', { defaultValue: 'Failures only' })}</option>
        </select>
      </label>
    </div>
    {value.executionMode === 'conversation' && <label className="block text-[13px]">{t('cron.execution.target', { defaultValue: 'Target conversation' })}
      <select className="pd-form-field mt-1.5" value={value.sessionKey} onChange={event => update({ sessionKey: event.target.value })}>
        <option value="">{t('cron.execution.chooseConversation', { defaultValue: 'Choose a conversation.' })}</option>
        {value.sessionKey && !sessions.some(session => session.id === value.sessionKey) && <option value={value.sessionKey}>{value.sessionKey}</option>}
        {sessions.filter(session => !session.id.startsWith('cron:')).map(session => <option key={session.id} value={session.id}>{session.title || session.summary || session.id}</option>)}
      </select>
      <p className="mt-1 text-xs text-neutral-500">{t('cron.execution.queueNotice', { defaultValue: 'Waits for the conversation to become idle before continuing with its history.' })}</p>
    </label>}
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <label className="text-[13px]">{t('cron.execution.permissions', { defaultValue: 'Permissions' })}
          <select className="pd-form-field mt-1.5" value={value.mode} onChange={event => update({ mode: event.target.value as CronExecutionDraft['mode'] })}>
            <option value="default">{t('cron.execution.restricted', { defaultValue: 'Restricted by existing permission rules' })}</option>
            <option value="plan">{t('cron.execution.readOnly', { defaultValue: 'Read only' })}</option>
            <option value="bypassPermissions">{t('cron.execution.fullAccess', { defaultValue: 'Full Access' })}</option>
          </select>
        </label>
        <label className="text-[13px]">{t('cron.execution.workspace', { defaultValue: 'Execution workspace' })}
          <select className="pd-form-field mt-1.5" value={value.workspaceMode} onChange={event => update({ workspaceMode: event.target.value as CronExecutionDraft['workspaceMode'] })}>
            <option value="local">{t('cron.execution.local', { defaultValue: 'Project working directory' })}</option>
            <option value="worktree" disabled={value.executionMode !== 'independent'}>{t('cron.execution.worktree', { defaultValue: 'Isolated Git worktree from committed HEAD' })}</option>
          </select>
        </label>
        <label className="text-[13px] sm:col-span-2">{t('cron.execution.model', { defaultValue: 'Model' })}
          <select className="pd-form-field mt-1.5" value={value.modelSelection ? JSON.stringify(value.modelSelection) : ''} onChange={event => update({ modelSelection: event.target.value ? JSON.parse(event.target.value) : undefined })}>
            <option value="">{t('cron.execution.defaultModel', { defaultValue: 'Use project default' })}</option>
            {options.models.filter(model => model.available && model.provider && model.model).map(model => <option key={`${model.provider}/${model.model}`} value={JSON.stringify({ provider: model.provider, model: model.model })}>{model.displayName || model.model}</option>)}
          </select>
        </label>
      </div>
      <p className="mt-2 text-xs text-neutral-500">{t('cron.execution.permissionNotice', { defaultValue: 'Tasks cannot ask for approval while unattended. Actions outside the selected permissions need your attention.' })}</p>
      {value.mode === 'bypassPermissions' && <p className="mt-2 text-xs text-amber-600">{t('cron.execution.fullAccessNotice', { defaultValue: 'Full Access permits background file changes and commands without asking.' })}</p>}
      {value.workspaceMode === 'worktree' && <p className="mt-2 text-xs text-neutral-500">{t('cron.execution.worktreeNotice', { defaultValue: 'Requires a Git repository. Local uncommitted changes are excluded; the resulting worktree is kept for review.' })}</p>}
    <p className="text-xs text-neutral-500">{t('cron.execution.resultsNotice', { defaultValue: 'Every result is saved here. Tasks created in chat can also report back to their source conversation.' })}</p>
    {error && <p role="alert" className="text-xs text-amber-600">{error}</p>}
    </div>
  </details>;
}
