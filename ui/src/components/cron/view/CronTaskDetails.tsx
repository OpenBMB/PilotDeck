import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, ChevronRight, Clock3, FileText, RefreshCw } from 'lucide-react';
import type { CronJobOverview, CronRunOverview, Project } from '../../../types/app';
import { api } from '../../../utils/api';
import { Markdown } from '../../chat/view/subcomponents/Markdown';
import { FileTypeIcon } from '../../file-tree/components/FileTypeIcon';
import { formatCronTime, taskEditDisabled } from './cronPresentation';

type Detail = { task: { name?: string; message: string; workspaceCwd?: string }; runs: CronRunOverview[]; nextRuns: string[]; nextBeforeRunId?: string };

export default function CronTaskDetails({ job, projects, onRefresh, onEdit, latestRunRequest }: {
  job: CronJobOverview; projects: Project[]; onRefresh: () => Promise<void>; onEdit: () => void;
  latestRunRequest?: number;
}) {
  const { t } = useTranslation('alwaysOn');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'result' | 'history'>('result');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  useEffect(() => { setSelectedRun(null); setTab('result'); }, [latestRunRequest]);
  const loaded = useRef(false);
  const requestId = useRef(0);
  const project = projects.find(project => project.fullPath === job.projectKey || project.name === job.projectKey);
  const load = useCallback(async (before?: string, quiet = false) => {
    const id = ++requestId.current;
    if (!quiet) setLoading(true);
    try {
      const response = await api.cronDetail(job.id, job.projectKey, before);
      const data = await response.json();
      if (id !== requestId.current) return;
      if (!response.ok) throw new Error(data.error || 'Failed to load task history.');
      setDetail(current => before && current ? { ...data, runs: [...current.runs, ...data.runs] } : data);
      setError(''); loaded.current = true;
    } catch (caught) { if (id === requestId.current) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [job.id, job.projectKey]);
  useEffect(() => { void load(undefined, loaded.current); }, [load, job.status, job.lastRun?.runId, job.lastRun?.finishedAt, job.lastRun?.deliveryStatus]);
  useEffect(() => () => { requestId.current += 1; }, []);
  const runs = detail?.runs || (job.lastRun ? [job.lastRun] : []);
  const run = runs.find(run => run.runId === selectedRun) || runs[0];
  const conversation = run && project ? `/p/${encodeURIComponent(project.name)}/c/${encodeURIComponent(run.sessionKey)}` : undefined;
  const status = run?.outcome || 'running';
  const format = (value?: string) => formatCronTime(value, job.timezone, 'medium');
  const retryDelivery = async () => {
    if (!run) return;
    try {
      const response = await api.cronRunNow(job.id, { projectKey: job.projectKey, retryDeliveryRunId: run.runId });
      const result = await response.json();
      if (!response.ok || !result.started) throw new Error(result.error || 'Delivery is still unavailable.');
      await load(); await onRefresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  return <section className="cron-task-detail dock-panel-scrollbar" aria-label={t('cron.history.title', { defaultValue: 'Run history and results' })}>
    <div className="cron-detail-inner">
      <div className="cron-detail-nav"><div role="tablist" aria-label={t('cron.history.title', { defaultValue: 'Run history and results' })}>
        <button type="button" role="tab" aria-selected={tab === 'result'} onClick={() => { setTab('result'); setSelectedRun(null); }}>{t('cron.workspace.result', { defaultValue: 'Result' })}</button>
        <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>{t('cron.history.title', { defaultValue: 'Run history and results' })}{runs.length > 0 && <span>{runs.length}{detail?.nextBeforeRunId ? '+' : ''}</span>}</button>
      </div><button type="button" className="cron-icon-button" disabled={loading} onClick={() => void load()} aria-label={t('cron.workspace.refreshResults', { defaultValue: 'Refresh results' })}><RefreshCw size={15} /></button></div>
      {error && <div className="cron-result-error" role="alert">{error}</div>}
      {tab === 'history' ? <div className="cron-run-history">
        {runs.length === 0 && <p className="cron-detail-muted">{t('cron.history.empty', { defaultValue: 'No runs yet. Try running this task once.' })}</p>}
        {runs.map(item => <button type="button" key={item.runId} className="cron-history-row" onClick={() => { setSelectedRun(item.runId); setTab('result'); }}>
          <span className={`cron-run-symbol ${item.outcome === 'completed' ? '' : item.finishedAt ? 'attention' : 'running'}`}>{item.outcome === 'completed' ? <Check size={16} /> : <Clock3 size={16} />}</span>
          <span className="cron-history-copy"><strong>{t(`cron.runStatus.${item.outcome || 'running'}`, { defaultValue: item.outcome || 'Running' })}<span>{t(`cron.trigger.${item.trigger || 'scheduled'}`, { defaultValue: item.trigger || 'Scheduled' })}</span></strong>
            <span>{format(item.startedAt)}</span><p>{item.error?.message || item.output?.replace(/\s+/g, ' ').slice(0, 150)}</p></span><ChevronRight size={15} />
        </button>)}
        {detail?.nextBeforeRunId && <button type="button" disabled={loading} className="cron-button cron-load-older" onClick={() => void load(detail.nextBeforeRunId)}>{t('cron.history.older', { defaultValue: 'Load older runs' })}</button>}
      </div> : run ? <article className="cron-run-result" aria-label={t('cron.workspace.executionResult', { defaultValue: 'Execution result' })}>
        <div className="cron-result-meta"><span className={`cron-result-status${status !== 'completed' && run.finishedAt ? ' attention' : ''}`}>{status === 'completed' ? <Check size={15} /> : <Clock3 size={15} />}{t(`cron.runStatus.${status}`, { defaultValue: status })}</span><span>{format(run.startedAt)}</span><span>{t(`cron.trigger.${run.trigger || 'scheduled'}`, { defaultValue: run.trigger || 'Scheduled' })}</span></div>
        {run.error && <p role="alert" className="cron-result-error">{run.error.message}</p>}
        {run.output ? <Markdown className="cron-result-markdown">{run.output.trim() === '[NO_UPDATE]' ? t('cron.workspace.noUpdates', { defaultValue: 'Nothing new to report from this check.' }) : run.output}</Markdown>
          : !run.finishedAt ? <div className="cron-result-waiting" role="status"><span className="cron-running-dot" /><p>{t('cron.workspace.runningHint', { defaultValue: 'Your task is running. Its result will appear here automatically.' })}</p></div>
            : !run.error && <p className="cron-detail-muted">{t('cron.workspace.noText', { defaultValue: 'This run finished without a text response.' })}</p>}
        {run.artifacts?.length ? <div className="cron-result-files">{run.artifacts.map(file => conversation ? <Link key={file.id} to={conversation} className="cron-file-card" title={t('cron.history.openConversation', { defaultValue: 'Open execution conversation and files' })}><FileTypeIcon filename={file.name} mimeType={file.mimeType} className="h-5 w-5" assetClassName="h-7 w-7" /><span><strong>{file.name}</strong><small>{file.size < 1024 ? `${file.size} B` : `${Math.round(file.size / 1024)} KB`}</small></span><ArrowUpRight size={15} /></Link> : <span key={file.id}>{file.name}</span>)}</div> : null}
        <div className="cron-result-links">{conversation && <Link to={conversation}><ArrowUpRight size={14} />{t('cron.history.openConversation', { defaultValue: 'Open execution conversation and files' })}</Link>}
          {run.deliveryStatus && <span className={run.deliveryStatus === 'failed' ? 'attention' : ''}>{t('cron.history.delivery', { defaultValue: 'Result delivery' })} · {t(`cron.delivery.${run.deliveryStatus}`, { defaultValue: run.deliveryStatus })}</span>}
          {run.deliveryStatus === 'failed' && <button type="button" onClick={() => void retryDelivery()}>{t('cron.history.retryDelivery', { defaultValue: 'Retry result delivery' })}</button>}
        </div>
        {run.deliveryError && <p className="cron-detail-muted">{run.deliveryError}</p>}
        <details className="cron-run-info"><summary>{t('cron.workspace.runDetails', { defaultValue: 'Run details' })}</summary><dl><dt>{t('cron.history.scheduledFor', { defaultValue: 'Scheduled for' })}</dt><dd>{format(run.scheduledAt)}</dd><dt>{t('cron.workspace.finishedAt', { defaultValue: 'Finished' })}</dt><dd>{format(run.finishedAt)}</dd><dt>{t('cron.create.fields.timezone', { defaultValue: 'Timezone' })}</dt><dd>{job.timezone || 'UTC'}</dd></dl>
          {run.workspaceCwd && <p className="cron-workspace-path">{run.workspaceCwd}</p>}
          <details><summary>{t('cron.history.snapshot', { defaultValue: 'Instructions used for this run' })}</summary><p className="cron-preserve-text">{run.message || t('cron.history.snapshotUnavailable', { defaultValue: 'Unavailable for this older run.' })}</p></details>
        </details>
      </article> : <div className="cron-first-run"><Clock3 size={26} strokeWidth={1.35} /><h2>{job.status === 'paused' ? t('cron.status.paused', { defaultValue: 'Paused' }) : job.nextRunAt ? t('cron.workspace.firstRun', { defaultValue: 'Your first result is on its way' }) : t('cron.workspace.noSavedRuns', { defaultValue: 'No saved results yet' })}</h2>
        <p>{job.nextRunAt ? t('cron.workspace.nextAt', { defaultValue: 'Next run · {{time}}', time: format(job.nextRunAt) }) : t('cron.history.empty', { defaultValue: 'No runs yet. Try running this task once.' })}</p><small>{job.timezone}</small>
        {job.statusDetail && <p className="cron-result-error">{job.statusDetail}</p>}
      </div>}
      <details className="cron-task-instructions"><summary><FileText size={14} />{t('cron.history.instructions', { defaultValue: 'Task instructions' })}</summary><p className="cron-preserve-text">{detail?.task.message || job.prompt}</p>
        <button type="button" className="cron-text-button" disabled={taskEditDisabled(job) !== null} onClick={onEdit}>{t('cron.actions.edit', { defaultValue: 'Edit' })}</button>
        {job.originSessionKey && <Link className="cron-text-button" to={`/session/${encodeURIComponent(job.originSessionKey)}`}>{t('cron.workspace.sourceConversation', { defaultValue: 'Source conversation' })}<ArrowUpRight size={13} /></Link>}
      </details>
    </div>
  </section>;
}
