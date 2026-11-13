import { useEffect, useRef, useState } from 'react';
import { ListFilter, Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CronJobOverview, Project } from '../../../types/app';
import CronTaskActions from './CronTaskActions';
import { cronScheduleLabel, formatCronTime, taskNeedsAttention } from './cronPresentation';

export default function CronTaskSidebar({ jobs, projects, selectedId, loading, query, setQuery, filter, setFilter, seenRuns, onSelect, onCreate, onEdit, onRefresh, onError, onDeleted }: {
  jobs: CronJobOverview[]; projects: Project[]; selectedId?: string; loading: boolean;
  query: string; setQuery: (value: string) => void; filter: string; setFilter: (value: string) => void;
  seenRuns: Record<string, string>; onSelect: (job: CronJobOverview) => void; onCreate: () => void;
  onEdit: (job: CronJobOverview) => void; onRefresh: () => Promise<void>; onError: (value: string) => void; onDeleted: (id: string) => void;
}) {
  const { t } = useTranslation('alwaysOn');
  const [searchOpen, setSearchOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const filterMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeFilter = (event: PointerEvent) => {
      if (filterMenu.current?.open && event.target instanceof Node && !filterMenu.current.contains(event.target)) filterMenu.current.open = false;
    };
    document.addEventListener('pointerdown', closeFilter);
    return () => document.removeEventListener('pointerdown', closeFilter);
  }, []);
  const labels: Record<string, string> = { all: 'All tasks', active: 'Active', paused: 'Paused', attention: 'Needs attention', ended: 'Finished' };
  const filtered = jobs.filter(job => (!query || `${job.name || ''} ${job.prompt}`.toLowerCase().includes(query.toLowerCase()))
    && (filter === 'all' || (filter === 'active' && ['scheduled', 'running'].includes(job.status))
      || (filter === 'paused' && job.status === 'paused') || (filter === 'attention' && taskNeedsAttention(job))
      || (filter === 'ended' && ['completed', 'failed', 'missed'].includes(job.status))));
  const groups = ['attention', 'active', 'paused', 'ended'].map(key => ({ key, items: filtered.filter(job =>
    (taskNeedsAttention(job) ? 'attention' : ['scheduled', 'running'].includes(job.status) ? 'active' : job.status === 'paused' ? 'paused' : 'ended') === key) }));
  const workspace = (job: CronJobOverview) => projects.find(project => project.fullPath === job.projectKey || project.name === job.projectKey)?.displayName
    || projects.find(project => project.fullPath === job.projectKey || project.name === job.projectKey)?.name
    || job.projectKey?.split(/[\\/]/).filter(Boolean).at(-1) || t('cron.unassigned', { defaultValue: 'Unassigned' });
  return <section className="cron-task-sidebar" aria-label={t('cron.title', { defaultValue: 'Scheduled tasks' })}>
    <div className="cron-sidebar-toolbar"><h2>{t('cron.title', { defaultValue: 'Scheduled tasks' })}</h2>
      <button type="button" className="cron-icon-button" aria-label={t('cron.search', { defaultValue: 'Search tasks' })} aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); if (!searchOpen) requestAnimationFrame(() => search.current?.focus()); }}><Search size={15} /></button>
      <details ref={filterMenu} className="cron-filter-menu" onKeyDown={event => { if (event.key === 'Escape' && filterMenu.current) { filterMenu.current.open = false; filterMenu.current.querySelector('summary')?.focus(); } }}>
        <summary className={`cron-icon-button${filter !== 'all' ? ' selected' : ''}`} aria-label={t('cron.filter', { defaultValue: 'Task status' })}><ListFilter size={16} /></summary>
        <div role="menu" className="cron-action-menu">{['all', 'active', 'paused', 'attention', 'ended'].map(value => <button type="button" key={value} role="menuitemradio" aria-checked={filter === value} onClick={() => { setFilter(value); if (filterMenu.current) filterMenu.current.open = false; }}>{t(`cron.filters.${value}`, { defaultValue: labels[value] })}</button>)}</div>
      </details>
      <button type="button" className="cron-icon-button" aria-label={t('cron.workspace.newTask', { defaultValue: 'New task' })} onClick={() => { if (filterMenu.current) filterMenu.current.open = false; onCreate(); }}><Plus size={16} /></button>
    </div>
    {(searchOpen || query) && <div className="cron-search"><input ref={search} aria-label={t('cron.search', { defaultValue: 'Search tasks' })} placeholder={t('cron.search', { defaultValue: 'Search tasks' })} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }} />{query && <button type="button" className="cron-icon-button" aria-label={t('cron.workspace.clearSearch', { defaultValue: 'Clear search' })} onClick={() => setQuery('')}><X size={13} /></button>}</div>}

    <div className="cron-task-list dock-panel-scrollbar">
      {loading && !jobs.length ? <p className="cron-list-empty">{t('cron.loading', { defaultValue: 'Loading cron jobs...' })}</p>
        : !filtered.length ? <p className="cron-list-empty">{t(jobs.length ? 'cron.workspace.noMatches' : 'cron.workspace.noTasks', { defaultValue: jobs.length ? 'No matching tasks.' : 'Your scheduled tasks will appear here.' })}</p> : groups.map(group => group.items.length > 0 && <div key={group.key} className="cron-task-group"><h3>{t(`cron.filters.${group.key}`, { defaultValue: labels[group.key] })}</h3>
          {group.items.map(job => {
            const unread = Boolean(job.lastRun?.finishedAt && seenRuns[job.id] !== job.lastRun.runId
              && (job.notificationPolicy !== 'failures' || job.lastRun.outcome !== 'completed')
              && (job.notificationPolicy !== 'findings' || job.lastRun.output?.trim() !== '[NO_UPDATE]'));
            const summary = job.status === 'running' ? t('cron.status.running', { defaultValue: 'Running' })
              : ['completed', 'failed', 'missed'].includes(job.status) ? t(`cron.status.${job.status}`, { defaultValue: job.status }) + ' · ' + formatCronTime(job.lastRun?.finishedAt || job.createdAt, job.timezone)
                : cronScheduleLabel(job.schedule, job.timezone, t);
            return <div key={job.id} className={`cron-task-row${selectedId === job.id ? ' selected' : ''}`}>
              <button type="button" className="cron-task-select" aria-label={t('cron.detailsFor', { defaultValue: 'View task details: {{name}}', name: job.name || job.prompt })} aria-current={selectedId === job.id ? 'true' : undefined} onClick={() => onSelect(job)}>
                <span className="cron-task-name">{unread && <span className="cron-unread" aria-label={t('cron.unread', { defaultValue: 'Unread result' })} />}{job.name || job.prompt}</span>
                <span className={`cron-task-summary${job.status === 'running' ? ' running' : ''}`} title={`${summary} · ${workspace(job)}`}>{summary} · {workspace(job)}</span>
              </button>
              <CronTaskActions job={job} compact onEdit={onEdit} onRefresh={onRefresh} onError={onError} onDeleted={onDeleted} />
            </div>;
          })}
        </div>)}
    </div>
  </section>;
}
