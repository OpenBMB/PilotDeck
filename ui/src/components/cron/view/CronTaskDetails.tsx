import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CronJobOverview, Project } from '../../../types/app';
import CronTaskConversation from './CronTaskConversation';
import { formatCronTime } from './cronPresentation';

/** The shared chat owns messages; the task supplies scheduling controls and its empty view. */
export default function CronTaskDetails({ job, projects, active = true, historyEpoch = 0, conversationRevision = 0 }: { job: CronJobOverview; projects: Project[]; active?: boolean; historyEpoch?: number; conversationRevision?: number }) {
  const { t } = useTranslation('alwaysOn');
  const waiting = !job.lastRun && !job.lastFiredAt && ['scheduled', 'paused'].includes(job.status);

  const paused = job.status === 'paused' || job.enabled === false;
  const nextRunAt = job.nextRunAt && Number.isFinite(Date.parse(job.nextRunAt)) ? job.nextRunAt : undefined;
  const emptyState = waiting ? <section className="cron-task-waiting h-full bg-white dark:bg-neutral-950" data-task-waiting={job.id}>
    <div className="cron-task-waiting-content">
      <span className="cron-empty-icon" aria-hidden="true"><CalendarClock size={28} strokeWidth={1.35} /></span>
      <h2>{t(paused ? 'cron.status.paused' : 'cron.workspace.firstRun')}</h2>
      {!paused && nextRunAt && <p>{t('cron.workspace.nextAt', { time: formatCronTime(nextRunAt, job.timezone, 'medium') })}</p>}
    </div>
  </section> : <div className="cron-workspace-empty h-full">{job.status !== 'running' && (job.lastRun?.error?.message || job.statusDetail)
    ? <p role="alert" className="max-w-2xl whitespace-pre-wrap text-red-600 dark:text-red-400">{job.lastRun?.error?.message || job.statusDetail}</p>
    : <h2>{t(job.status === 'running' ? 'cron.workspace.runningHint' : 'cron.workspace.noSavedRuns')}</h2>}</div>;
  return <CronTaskConversation job={job} projects={projects} active={active} historyEpoch={historyEpoch} conversationRevision={conversationRevision} emptyState={emptyState} />;
}
