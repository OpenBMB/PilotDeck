import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, CircleAlert, ListFilter, Loader2, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CronJobOverview, Project } from '../../../types/app';
import SidebarSectionHeading from '../../app-shell/SidebarSectionHeading';
import { useFloatingPanel } from '../../ui/useFloatingPanel';
import CronTaskActions from './CronTaskActions';
import { cronScheduleLabel, formatCronTime, taskNeedsAttention } from './cronPresentation';

type Props = {
  jobs: CronJobOverview[]; projects: Project[]; selectedId?: string; loading: boolean;
  compact?: boolean; expanded?: boolean; onToggle?: () => void;
  query: string; setQuery: (value: string) => void; filter: string; setFilter: (value: string) => void;
  seenRuns: Record<string, string>; onSelect: (job: CronJobOverview) => void; onCreate: () => void;
  onEdit: (job: CronJobOverview) => void; onRefresh: () => Promise<void>; onError: (value: string) => void; onDeleted: (id: string) => void;
};
const labels: Record<string, string> = { all: 'All tasks', active: 'Active', paused: 'Paused', attention: 'Needs attention', ended: 'Finished' };

export default function CronTaskSidebar({ jobs, projects, selectedId, loading, compact = false, expanded = true, onToggle,
  query, setQuery, filter, setFilter, seenRuns, onSelect, onCreate, onEdit, onRefresh, onError, onDeleted }: Props) {
  const { t } = useTranslation('alwaysOn');
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const filterAnchor = useRef<HTMLButtonElement>(null);
  const { panelRef, style } = useFloatingPanel(menuOpen, filterAnchor, () => setMenuOpen(false), { side: 'below', width: 210, maxHeight: 340 });
  useEffect(() => { setMenuOpen(false); }, [compact]);
  useLayoutEffect(() => {
    if (menuOpen && style.visibility !== 'hidden') panelRef.current?.querySelector<HTMLElement>('input, [role="menuitemradio"]')?.focus();
  }, [menuOpen, panelRef, style.visibility]);
  const filtered = jobs.filter(job => (!query || `${job.name || ''} ${job.prompt}`.toLowerCase().includes(query.toLowerCase()))
    && (filter === 'all' || (filter === 'active' && ['scheduled', 'running'].includes(job.status))
      || (filter === 'paused' && job.status === 'paused') || (filter === 'attention' && taskNeedsAttention(job))
      || (filter === 'ended' && ['completed', 'failed', 'missed'].includes(job.status))));
  const groups = ['attention', 'active', 'paused', 'ended'].map(key => ({ key, items: filtered.filter(job =>
    (taskNeedsAttention(job) ? 'attention' : ['scheduled', 'running'].includes(job.status) ? 'active' : job.status === 'paused' ? 'paused' : 'ended') === key) }));
  const workspace = (job: CronJobOverview) => projects.find(project => project.fullPath === job.projectKey || project.name === job.projectKey)?.displayName
    || projects.find(project => project.fullPath === job.projectKey || project.name === job.projectKey)?.name
    || job.projectKey?.split(/[\\/]/).filter(Boolean).at(-1) || t('cron.unassigned', { defaultValue: 'Unassigned' });
  const createLabel = t('cron.workspace.newTask', { defaultValue: 'New task' });
  const filterLabel = compact ? t('cron.workspace.listOptions', { defaultValue: 'Task list options' }) : t('cron.filter', { defaultValue: 'Task status' });
  const filterButton = <button ref={filterAnchor} type="button" aria-label={filterLabel} title={filterLabel}
    aria-haspopup="menu" aria-expanded={menuOpen} className={filter !== 'all' || query ? 'text-[var(--pd-accent)]' : undefined}
    onClick={() => setMenuOpen(current => !current)}>
    {compact ? <MoreHorizontal className="icon" size={16} strokeWidth={1.8} /> : <ListFilter className="icon" size={16} strokeWidth={1.8} />}
  </button>;
  const searchField = <div className="cron-search"><input ref={search} aria-label={t('cron.search', { defaultValue: 'Search tasks' })}
    placeholder={t('cron.search', { defaultValue: 'Search tasks' })} value={query} onChange={event => setQuery(event.target.value)}
    onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }} />
    {query && <button type="button" className="cron-icon-button" aria-label={t('cron.workspace.clearSearch', { defaultValue: 'Clear search' })} onClick={() => setQuery('')}><X size={13} /></button>}
  </div>;
  const renderTask = (job: CronJobOverview) => {
    const unread = Boolean(job.lastRun?.finishedAt && seenRuns[job.id] !== job.lastRun.runId
      && (job.notificationPolicy !== 'failures' || job.lastRun.outcome !== 'completed')
      && (job.notificationPolicy !== 'findings' || job.lastRun.output?.trim() !== '[NO_UPDATE]'));
    const summary = job.status === 'running' ? t('cron.status.running', { defaultValue: 'Running' })
      : ['completed', 'failed', 'missed'].includes(job.status) ? t(`cron.status.${job.status}`, { defaultValue: job.status }) + ' · ' + formatCronTime(job.lastRun?.finishedAt || job.createdAt, job.timezone)
        : cronScheduleLabel(job.schedule, job.timezone, t);
    return <TaskRow key={job.id} job={job} compact={compact} selected={selectedId === job.id} unread={unread}
      summary={`${summary} · ${workspace(job)}`} onSelect={onSelect} onEdit={onEdit} onRefresh={onRefresh} onError={onError} onDeleted={onDeleted} />;
  };
  return <section className={`cron-task-sidebar${compact ? ' compact' : ' tree-section'}`} aria-label={t('cron.title', { defaultValue: 'Scheduled tasks' })}>
    {compact ? <div className="tree-heading-actions cron-compact-toolbar">
      <button type="button" aria-label={createLabel} title={createLabel} onClick={onCreate}><Plus className="icon" size={16} strokeWidth={1.8} /></button>
      {filterButton}
    </div> : <SidebarSectionHeading title={t('cron.title', { defaultValue: 'Scheduled tasks' })} expanded={expanded}
      expandLabel={t('cron.workspace.expandTasks', { defaultValue: 'Expand tasks' })} collapseLabel={t('cron.workspace.collapseTasks', { defaultValue: 'Collapse tasks' })}
      actionLabel={createLabel} actionIcon={<Plus className="icon" size={16} strokeWidth={1.8} />} onAction={onCreate} onToggle={() => onToggle?.()}>
      <button type="button" aria-label={t('cron.search', { defaultValue: 'Search tasks' })} title={t('cron.search', { defaultValue: 'Search tasks' })}
        aria-expanded={searchOpen} onClick={() => { setSearchOpen(current => !current); if (!searchOpen) requestAnimationFrame(() => search.current?.focus()); }}><Search className="icon" size={15} strokeWidth={1.8} /></button>
      {filterButton}
    </SidebarSectionHeading>}
    {!compact && (searchOpen || query) && searchField}
    {(expanded || compact) && <div className={`cron-task-list dock-panel-scrollbar${compact ? ' recent-list' : ' tree-list chat-tree-list'}`}>
      {loading && !jobs.length ? <p className="cron-list-empty">{t('cron.loading', { defaultValue: 'Loading cron jobs...' })}</p>
        : !filtered.length ? <p className="cron-list-empty">{t(jobs.length ? 'cron.workspace.noMatches' : 'cron.workspace.noTasks', { defaultValue: jobs.length ? 'No matching tasks.' : 'Your scheduled tasks will appear here.' })}</p>
          : compact ? groups.flatMap(group => group.items).map(renderTask) : groups.map(group => group.items.length > 0 && <div key={group.key} className="cron-task-group">
            <h3>{t(`cron.filters.${group.key}`, { defaultValue: labels[group.key] })}</h3>{group.items.map(renderTask)}
          </div>)}
    </div>}
    {menuOpen && createPortal(<div ref={panelRef} role="menu" aria-label={filterLabel} className="cron-action-menu" style={style}
      onKeyDown={event => {
        if (event.target instanceof HTMLInputElement || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }}>
      {compact && searchField}
      {['all', 'active', 'paused', 'attention', 'ended'].map(value => <button type="button" key={value} role="menuitemradio" aria-checked={filter === value}
        onClick={() => { setFilter(value); filterAnchor.current?.focus(); setMenuOpen(false); }}>{t(`cron.filters.${value}`, { defaultValue: labels[value] })}</button>)}
    </div>, document.body)}
  </section>;
}

function TaskRow({ job, compact, selected, unread, summary, onSelect, ...actions }: Pick<Props, 'onSelect' | 'onEdit' | 'onRefresh' | 'onError' | 'onDeleted'> & {
  job: CronJobOverview; compact: boolean; selected: boolean; unread: boolean; summary: string;
}) {
  const { t } = useTranslation('alwaysOn');
  const anchor = useRef<HTMLButtonElement>(null);
  const [menuRequest, setMenuRequest] = useState(0);
  const status = job.status === 'running' ? 'processing' : taskNeedsAttention(job) ? 'approval' : unread ? 'unread' : 'idle';
  const name = job.name || job.prompt;
  const indicator = status === 'processing' ? <Loader2 aria-hidden="true" className="icon animate-spin" size={compact ? 20 : 12} />
    : status === 'approval' ? <CircleAlert aria-hidden="true" className="icon text-amber-500" size={compact ? 20 : 14} strokeWidth={1.8} />
      : status === 'unread' ? <span aria-hidden="true" className="conversation-dot" /> : <CalendarClock aria-hidden="true" className="icon" size={compact ? 20 : 16} strokeWidth={1.8} />;
  return <div className={`cron-task-row group/session relative w-full${compact ? ' compact' : ''}`}>
    <button ref={anchor} type="button" className={`${compact ? 'compact-project-entry tooltip tooltip-right' : 'tree-row chat-row cron-task-select'}${selected ? ' active' : ''}`}
      aria-label={t('cron.detailsFor', { defaultValue: 'View task details: {{name}}', name })} aria-current={selected ? 'true' : undefined} title={`${name}\n${summary}`} data-tooltip={name}
      onClick={() => onSelect(job)} onContextMenu={event => { if (compact) { event.preventDefault(); setMenuRequest(current => current + 1); } }}
      onKeyDown={event => { if (compact && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenuRequest(current => current + 1); } }}>
      <span className={compact ? 'cron-compact-indicator' : 'session-indicator session-indicator-flat'} data-status={status}
        aria-label={unread ? t('cron.unread', { defaultValue: 'Unread result' }) : undefined}>{indicator}</span>
      {compact ? <span>{name}</span> : <div className="min-w-0"><div className="truncate font-normal">{name}</div><div className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">{summary}</div></div>}
    </button>
    <CronTaskActions {...actions} job={job} compact menuAnchor={compact ? anchor : undefined} menuRequest={compact ? menuRequest : 0} />
  </div>;
}
