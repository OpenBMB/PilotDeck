import { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { X, RefreshCw } from 'lucide-react';
import type { CronJobOverview, CronRunOverview, Project } from '../../../types/app';
import { api } from '../../../utils/api';

type Detail = { task: { name?: string; message: string; workspaceCwd?: string }; runs: CronRunOverview[]; nextRuns: string[]; nextBeforeRunId?: string };

export default function CronTaskDetails({ job, projects, onClose, onRefresh }: {
  job: CronJobOverview; projects: Project[]; onClose: () => void; onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation('alwaysOn');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const project = projects.find(project => project.fullPath === job.projectKey || project.name === job.projectKey);
  const load = useCallback(async (before?: string) => {
    setLoading(true);
    try {
      const response = await api.cronDetail(job.id, job.projectKey, before);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load task history.');
      setDetail(current => before && current ? { ...data, runs: [...current.runs, ...data.runs] } : data);
      setError('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLoading(false); }
  }, [job.id, job.projectKey]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const format = (value: string) => new Date(value).toLocaleString(undefined, { timeZone: job.timezone || undefined });
  return ReactDOM.createPortal(<div className="fixed inset-0 z-[65] flex justify-end bg-black/40" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="cron-detail-title" className="flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl dark:bg-neutral-950" onClick={event => event.stopPropagation()}>
      <header className="flex items-center justify-between gap-4 border-b border-neutral-200 p-5 dark:border-neutral-800">
        <div><h2 id="cron-detail-title" className="font-semibold">{job.name || job.prompt.split('\n')[0]}</h2><p className="mt-1 text-xs text-neutral-500">{t('cron.history.title', { defaultValue: 'Run history and results' })} · {job.timezone}</p></div>
        <div className="flex gap-2"><button type="button" disabled={loading} className="rounded p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => void load()} aria-label={t('actions.refresh', { defaultValue: 'Refresh' })}><RefreshCw size={16} /></button><button autoFocus type="button" className="rounded p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={onClose} aria-label={t('cron.history.close', { defaultValue: 'Close details' })}><X size={18} /></button></div>
      </header>
      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        <details><summary className="cursor-pointer text-sm font-medium">{t('cron.history.instructions', { defaultValue: 'Task instructions' })}</summary><p className="mt-2 whitespace-pre-wrap text-sm">{detail?.task.message || job.prompt}</p></details>
        {detail?.nextRuns.length ? <div className="rounded-lg bg-neutral-50 p-3 text-xs dark:bg-neutral-900"><p className="mb-1 font-medium">{t('cron.preview', { defaultValue: 'Next runs' })}</p>{detail.nextRuns.map(time => <p key={time}>{format(time)}</p>)}</div> : null}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {detail?.runs.length === 0 && <p className="py-8 text-center text-sm text-neutral-500">{t('cron.history.empty', { defaultValue: 'No runs yet. Try running this task once.' })}</p>}
        {detail?.runs.map(run => <article key={run.runId} className="space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><strong>{t(`cron.runStatus.${run.outcome || 'running'}`, { defaultValue: run.outcome || 'Running' })}</strong><span className="text-xs text-neutral-500">{t(`cron.trigger.${run.trigger || 'scheduled'}`, { defaultValue: run.trigger || 'Scheduled' })} · {format(run.startedAt)}</span></div>
          {run.scheduledAt && <p className="text-xs text-neutral-500">{t('cron.history.scheduledFor', { defaultValue: 'Scheduled for' })}: {format(run.scheduledAt)}</p>}
          {run.error && <p role="alert" className="whitespace-pre-wrap rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">{run.error.message}</p>}
          {run.output && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6">{run.output}</pre>}
          {run.deliveryStatus && <p className="text-xs text-neutral-500">{t('cron.history.delivery', { defaultValue: 'Result delivery' })}: {t(`cron.delivery.${run.deliveryStatus}`, { defaultValue: run.deliveryStatus })}{run.deliveryError ? ` · ${run.deliveryError}` : ''}</p>}
          {run.artifacts?.length ? <div className="flex flex-wrap gap-2">{run.artifacts.map(file => <span key={file.id} className="rounded border px-2 py-1 text-xs">{file.name}</span>)}</div> : null}
          <div className="flex flex-wrap gap-3 text-xs">
            {project && <Link to={`/p/${encodeURIComponent(project.name)}/c/${encodeURIComponent(run.sessionKey)}`} className="text-blue-600 hover:underline" onClick={onClose}>{t('cron.history.openConversation', { defaultValue: 'Open execution conversation and files' })}</Link>}
            {run.workspaceCwd && run.workspaceCwd !== job.workspaceCwd && <span className="break-all text-neutral-500">{run.workspaceCwd}</span>}
            {run.deliveryStatus === 'failed' && <button type="button" className="text-blue-600 hover:underline" onClick={async () => {
              try { const response = await api.cronRunNow(job.id, { projectKey: job.projectKey, retryDeliveryRunId: run.runId }); const result = await response.json(); if (!response.ok || !result.started) throw new Error(result.error || 'Delivery is still unavailable.'); await load(); await onRefresh(); }
              catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
            }}>{t('cron.history.retryDelivery', { defaultValue: 'Retry result delivery' })}</button>}
          </div>
          <details className="text-xs text-neutral-500"><summary className="cursor-pointer">{t('cron.history.snapshot', { defaultValue: 'Instructions used for this run' })}</summary><p className="mt-2 whitespace-pre-wrap">{run.message || t('cron.history.snapshotUnavailable', { defaultValue: 'Unavailable for this older run.' })}</p></details>
        </article>)}
        {detail?.nextBeforeRunId && <button type="button" disabled={loading} className="w-full rounded-lg border p-2 text-sm" onClick={() => void load(detail.nextBeforeRunId)}>{t('cron.history.older', { defaultValue: 'Load older runs' })}</button>}
      </div>
    </section>
  </div>, document.body);
}
