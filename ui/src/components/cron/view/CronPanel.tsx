import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { CalendarClock, PanelLeftOpen, Plus } from 'lucide-react';
import type { CronJobOverview, CronJobsOverviewResponse, Project } from '../../../types/app';
import { api } from '../../../utils/api';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useCronSidebar } from '../CronSidebarContext';
import CronTaskSidebar from './CronTaskSidebar';
import WorkspaceProjectLabel from '../../app-shell/WorkspaceProjectLabel';
import CronTaskDetails from './CronTaskDetails';
import CronTaskEditor from './CronTaskEditor';
import CronTaskActions from './CronTaskActions';
import { cronScheduleLabel, taskEditDisabled } from './cronPresentation';
import './cron-workspace.css';

const noRefresh = async () => {};
const newestFirst = (jobs: CronJobOverview[]) => [...jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

/** Kept mounted by MainArea: navigation retains the list, session cache and reading position. */
export default function CronPanel({ isSidebarCollapsed, onOpenSidebar, projects: shellProjects, active = true }: {
  isSidebarCollapsed?: boolean; onOpenSidebar?: () => void; projects?: Project[]; active?: boolean;
} = {}) {
  const { t } = useTranslation('alwaysOn');
  const { subscribe, isConnected } = useWebSocket();
  const sidebar = useCronSidebar();
  const [params, setParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackProjects, setFallbackProjects] = useState<Project[]>([]);
  const projects = shellProjects || fallbackProjects;
  const [jobs, setJobs] = useState<CronJobOverview[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('taskId'));
  const [editor, setEditor] = useState<{ job: CronJobOverview | null } | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [listExpanded, setListExpanded] = useState(true);
  const request = useRef<AbortController | null>(null);
  const changes = useRef(new Map<string, CronJobOverview | null>());
  const [seenRuns, setSeenRuns] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('pilotdeck-cron-seen-runs') || '{}'); } catch { return {}; }
  });
  const requestedId = active ? params.get('taskId') : null;
  useEffect(() => { if (requestedId) setSelectedId(requestedId); }, [requestedId]);
  const selected = jobs.find(job => job.id === selectedId) || jobs[0];
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    changes.current.clear();
    setLoading(true);
    try {
      const [projectsRes, jobsRes] = await Promise.all([
        shellProjects ? Promise.resolve(null) : api.projects({ signal: controller.signal }),
        api.allCronJobs({ signal: controller.signal }),
      ]);
      if (projectsRes && !projectsRes.ok) throw new Error(`Projects: HTTP ${projectsRes.status}`);
      if (!jobsRes.ok) throw new Error(`Cron jobs: HTTP ${jobsRes.status}`);
      const payload = await jobsRes.json() as CronJobsOverviewResponse;
      const loadedProjects = projectsRes ? await projectsRes.json() as Project[] : null;
      if (controller.signal.aborted) return;
      if (loadedProjects) setFallbackProjects(loadedProjects);
      const snapshot = new Map((payload.jobs || []).map(job => [job.id, job]));
      for (const [id, job] of changes.current) {
        if (!job) snapshot.delete(id);
        else if ((snapshot.get(id)?.revision ?? -1) <= (job.revision ?? 0)) snapshot.set(id, job);
      }
      setJobs(newestFirst([...snapshot.values()])); setError(null);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    } finally { if (request.current === controller) { request.current = null; setLoading(false); } }
  }, [Boolean(shellProjects)]);
  useEffect(() => {
    const unsubscribe = subscribe(message => {
      if (message.type !== 'cron-task-changed' || typeof message.taskId !== 'string') return;
      const job = message.job as CronJobOverview | null;
      if (request.current) changes.current.set(message.taskId, job);
      setJobs(current => {
        const previous = current.find(item => item.id === message.taskId);
        if (job && previous && (previous.revision ?? 0) > (job.revision ?? 0)) return current;
        return newestFirst([...current.filter(item => item.id !== message.taskId), ...(job ? [job] : [])]);
      });
    });
    void load();
    return () => { unsubscribe(); request.current?.abort(); request.current = null; };
  }, [subscribe, load]);
  const connected = useRef(isConnected);
  useEffect(() => {
    if (isConnected && !connected.current) void load();
    connected.current = isConnected;
  }, [isConnected, load]);
  useEffect(() => {
    if (!active || !selected?.lastRun?.finishedAt || document.visibilityState === 'hidden') return;
    const { id, lastRun } = selected;
    setSeenRuns(current => {
      if (current[id] === lastRun.runId) return current;
      const next = { ...current, [id]: lastRun.runId };
      try { localStorage.setItem('pilotdeck-cron-seen-runs', JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
      return next;
    });
  }, [active, selected?.id, selected?.lastRun?.runId, selected?.lastRun?.finishedAt]);
  const select = (job: CronJobOverview) => { setSelectedId(job.id); setParams({ taskId: job.id }, { replace: true }); sidebar?.onSelect(); setError(null); };
  const edit = (job: CronJobOverview) => { if (!taskEditDisabled(job)) setEditor({ job }); };
  const deleted = (id: string) => { if (id === selected?.id) { setSelectedId(null); setParams({}, { replace: true }); } };
  const list = <CronTaskSidebar compact={sidebar?.compact} expanded={listExpanded} onToggle={() => setListExpanded(current => !current)} jobs={jobs} projects={projects} selectedId={selected?.id} loading={loading}
    query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} seenRuns={seenRuns}
    onSelect={select} onCreate={() => setEditor({ job: null })} onEdit={edit} onRefresh={noRefresh} onError={setError} onDeleted={deleted} />;
  const project = selected && projects.find(item => item.fullPath === selected.projectKey || item.name === selected.projectKey);
  const projectLabel = project?.kind === 'general' || project?.name === 'general' ? t('sidebar:general.name', { defaultValue: 'General conversation' })
    : project?.displayName || project?.name || selected?.projectKey || '';
  return <div className="cron-workspace">
    {active && (sidebar ? sidebar.host && createPortal(list, sidebar.host) : <aside className="cron-standalone-sidebar">{list}</aside>)}
    <div className="cron-result-workspace">
      <header className="workspace-header relative z-[80] shrink-0 overflow-visible">
        {isSidebarCollapsed && <button type="button" className="icon-button mr-4" onClick={onOpenSidebar} aria-label={t('cron.workspace.showTasks')}><PanelLeftOpen size={18} /></button>}
        <div className="workspace-title flex-1"><h1 className="min-w-0 max-w-[34rem] truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-50">{selected?.name || selected?.prompt.split('\n')[0] || t('cron.title')}</h1>
          {selected && <WorkspaceProjectLabel label={projectLabel}><span className="min-w-0 truncate">· {cronScheduleLabel(selected.schedule, selected.timezone, t)}</span></WorkspaceProjectLabel>}
        </div>
        {selected && <div className="workspace-actions ml-4 h-9 shrink-0"><CronTaskActions key={selected.id} job={selected} onEdit={edit} onRefresh={noRefresh} onError={setError} onDeleted={deleted} /></div>}
      </header>
      {error && <div role="alert" className="cron-workspace-error">{error}<button type="button" className="cron-text-button ml-3" onClick={() => void load()}>{t('actions.refresh', { defaultValue: 'Retry' })}</button></div>}
      {selected ? <CronTaskDetails job={selected} projects={projects} />
        : <div className="cron-workspace-empty"><span className="cron-empty-icon"><CalendarClock size={30} strokeWidth={1.35} /></span>
          <h2>{t('cron.workspace.emptyTitle')}</h2>
          <p>{t('cron.workspace.emptyHint')}</p>
          {!selected && !loading && !jobs.length && <button type="button" className="cron-icon-button" aria-label={t('cron.workspace.newTask', { defaultValue: 'New task' })} onClick={() => setEditor({ job: null })}><Plus size={18} /></button>}
        </div>}
    </div>
    {editor && <CronTaskEditor key={editor.job?.id || 'create'} t={t} projects={projects} editingJob={editor.job}
      onCancel={() => setEditor(null)} onCompleted={async taskId => {
        if (taskId) { setSelectedId(taskId); setParams({ taskId }, { replace: true }); }
        setEditor(null); sidebar?.onSelect();
      }} />}
  </div>;
}
