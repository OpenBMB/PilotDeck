import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Pause, Pencil, Play, Square, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CronJobOverview } from '../../../types/app';
import { api } from '../../../utils/api';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useFloatingPanel } from '../../ui/useFloatingPanel';
import { taskEditDisabled } from './cronPresentation';

export default function CronTaskActions({ job, compact = false, onEdit, onRefresh, onError, onDeleted, onRunStarted }: {
  job: CronJobOverview; compact?: boolean; onEdit: (job: CronJobOverview) => void;
  onRefresh: () => Promise<void>; onError: (message: string) => void; onDeleted?: (id: string) => void;
  onRunStarted?: () => void;
}) {
  const { t } = useTranslation('alwaysOn');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const { panelRef, style } = useFloatingPanel(open, anchor, () => setOpen(false), { side: 'below', width: 180, maxHeight: 270 });
  useEffect(() => { if (open) panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus(); }, [open, panelRef, style.visibility]);
  const canResume = job.enabled === false || ['paused', 'failed', 'missed', 'completed'].includes(job.status);
  const canToggle = job.schedule?.type !== 'once' || ['scheduled', 'running', 'paused'].includes(job.status) || Date.parse(job.schedule.runAt) > Date.now();
  const disabled = taskEditDisabled(job);
  const action = async (kind: 'run' | 'stop' | 'toggle' | 'delete') => {
    if (busy) return;
    setOpen(false); setBusy(true); setDeleteError(null);
    try {
      const response = kind === 'run' ? await api.cronRunNow(job.id)
        : kind === 'stop' ? await api.cronStop(job.id)
          : kind === 'delete' ? await api.cronDelete(job.id)
            : await api.cronUpdate(job.id, { projectKey: job.projectKey, expectedRevision: job.revision,
              message: job.prompt, schedule: job.schedule, timezone: job.timezone, enabled: canResume });
      const result = await response.json();
      if (!response.ok || result.started === false || result.stopped === false || result.updated === false || result.deleted === false) {
        throw new Error(result.error || t(`cron.errors.${result.reason || 'conflict'}`, { defaultValue: result.reason || 'The task changed. Refresh and try again.' }));
      }
      if (kind === 'delete') setDeleting(false);
      await onRefresh();
      if (kind === 'run') onRunStarted?.();
      if (kind === 'delete') onDeleted?.(job.id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (kind === 'delete') setDeleteError(message); else onError(message);
    } finally { setBusy(false); }
  };
  const runLabel = job.status === 'running' ? t('cron.actions.stop', { defaultValue: 'Stop' }) : t('cron.actions.runNow', { defaultValue: 'Run Now' });
  const editTitle = disabled ? t(`cron.edit.disabled.${disabled}`, { defaultValue: disabled === 'running' ? 'Stop the running task before editing.' : disabled === 'unsupported' ? 'This task uses a schedule that cannot be edited on this page.' : 'This task is missing the details required for editing.' }) : t('cron.actions.edit', { defaultValue: 'Edit' });
  const prompt = job.name || job.prompt;
  return <div className={`cron-task-actions${compact ? ' compact' : ''}`}>
    {!compact && <button className={`cron-button cron-run-button${job.status === 'running' ? ' danger' : ''}`} type="button" disabled={busy} onClick={() => void action(job.status === 'running' ? 'stop' : 'run')}>
      {job.status === 'running' ? <Square size={14} /> : <Play size={14} />}{runLabel}
    </button>}
    <button ref={anchor} type="button" className="cron-icon-button" aria-label={compact ? t('cron.workspace.actionsFor', { defaultValue: 'Task actions: {{name}}', name: job.name || job.prompt }) : t('cron.workspace.taskActions', { defaultValue: 'Task actions' })} aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}><MoreHorizontal size={18} /></button>
    {open && createPortal(<div ref={panelRef} role="menu" className="cron-action-menu" style={style} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }}>
      {compact && <button type="button" role="menuitem" onClick={() => void action(job.status === 'running' ? 'stop' : 'run')}><Play size={14} />{runLabel}</button>}
      {canToggle && <button type="button" role="menuitem" onClick={() => void action('toggle')}><Pause size={14} />{canResume ? t('cron.actions.resume', { defaultValue: 'Resume' }) : t('cron.actions.pause', { defaultValue: 'Pause' })}</button>}
      <button type="button" role="menuitem" disabled={disabled !== null} title={editTitle} onClick={() => { anchor.current?.focus(); setOpen(false); onEdit(job); }}><Pencil size={14} />{t('cron.actions.edit', { defaultValue: 'Edit' })}</button>
      <div className="cron-menu-divider" />
      <button type="button" role="menuitem" className="danger" onClick={() => { anchor.current?.focus(); setOpen(false); setDeleting(true); }}><Trash2 size={14} />{t('cron.actions.delete', { defaultValue: 'Delete' })}</button>
    </div>, document.body)}
    {deleting && <ConfirmDialog title={t('cron.deleteConfirm.title', { defaultValue: 'Delete cron task?' })} destructive busy={busy} error={deleteError}
      confirmLabel={t('cron.deleteConfirm.confirm', { defaultValue: 'Delete' })} onCancel={() => setDeleting(false)} onConfirm={() => void action('delete')}>
      <p className="mb-2 line-clamp-2 break-words font-medium text-foreground">{prompt.length > 160 ? `${prompt.slice(0, 160)}…` : prompt}</p>{t('cron.deleteConfirm.description', { defaultValue: 'This cron task will be permanently deleted.' })}
    </ConfirmDialog>}
  </div>;
}
