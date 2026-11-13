import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { CalendarClock, PanelLeftOpen, Plus } from 'lucide-react';
import type { CronJobOverview, CronJobsOverviewResponse, Project } from '../../../types/app';
import { api } from '../../../utils/api';
import { useCronSidebar } from '../CronSidebarContext';
import CronTaskSidebar from './CronTaskSidebar';
import CronTaskDetails from './CronTaskDetails';
import CronTaskEditor from './CronTaskEditor';
import CronTaskActions from './CronTaskActions';
import { cronScheduleLabel, taskEditDisabled } from './cronPresentation';
import './cron-workspace.css';

const POLL_INTERVAL_MS = 15_000;

export default function CronPanel({ isSidebarCollapsed, onOpenSidebar }: { isSidebarCollapsed?: boolean; onOpenSidebar?: () => void } = {}) {
  const { t } = useTranslation('alwaysOn');
  const sidebar = useCronSidebar();
  const [params, setParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<CronJobOverview[]>([]);
  const [editor, setEditor] = useState<{ job: CronJobOverview | null } | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [latestRunRequest, setLatestRunRequest] = useState(0);
  const request = useRef<AbortController | null>(null);
  const [seenRuns, setSeenRuns] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('pilotdeck-cron-seen-runs') || '{}'); } catch { return {}; }
  });
  const requestedId = params.get('taskId');
  const selected = jobs.find(job => job.id === requestedId) || (!requestedId ? jobs[0] : undefined);
  const load = useCallback(async (quiet = false) => {
    if (quiet && request.current) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    if (!quiet) setLoading(true);
    try {
      const [projectsRes, jobsRes] = await Promise.all([quiet ? Promise.resolve(null) : api.projects({ signal: controller.signal }), api.allCronJobs({ signal: controller.signal })]);
      if (projectsRes && !projectsRes.ok) throw new Error(`Projects: HTTP ${projectsRes.status}`);
      if (!jobsRes.ok) throw new Error(`Cron jobs: HTTP ${jobsRes.status}`);
      const projectsPayload = projectsRes ? await projectsRes.json() as Project[] : null;
      const jobsPayload = await jobsRes.json() as CronJobsOverviewResponse;
      if (controller.signal.aborted) return;
      if (projectsRes) { const next = Array.isArray(projectsPayload) ? projectsPayload : []; setProjects(current => JSON.stringify(current) === JSON.stringify(next) ? current : next); }
      const nextJobs = (Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : []).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      setJobs(current => JSON.stringify(current) === JSON.stringify(nextJobs) ? current : nextJobs);
      setError(null);
    } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (request.current === controller) { request.current = null; setLoading(false); } }
  }, []);
  const refresh = useCallback(() => load(), [load]);
  useEffect(() => { void refresh(); return () => { request.current?.abort(); request.current = null; }; }, [refresh]);
  useEffect(() => {
    if (editor) return;
    const poll = () => { if (document.visibilityState !== 'hidden') void load(true); };
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [load, editor]);
  useEffect(() => {
    if (!selected?.lastRun?.finishedAt || document.visibilityState === 'hidden') return;
    const { id, lastRun } = selected;
    setSeenRuns(current => {
      if (current[id] === lastRun.runId) return current;
      const next = { ...current, [id]: lastRun.runId };
      try { localStorage.setItem('pilotdeck-cron-seen-runs', JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
      return next;
    });
  }, [selected?.id, selected?.lastRun?.runId, selected?.lastRun?.finishedAt]);
  const select = (job: CronJobOverview) => { setParams({ taskId: job.id }, { replace: true }); sidebar?.onSelect(); setError(null); };
  const edit = (job: CronJobOverview) => { if (!taskEditDisabled(job)) setEditor({ job }); };
  const deleted = (id: string) => { if (id === selected?.id) setParams({}, { replace: true }); };
  const list = <CronTaskSidebar jobs={jobs} projects={projects} selectedId={selected?.id} loading={loading} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} seenRuns={seenRuns}
    onSelect={select} onCreate={() => setEditor({ job: null })} onEdit={edit} onRefresh={refresh} onError={setError} onDeleted={deleted} />;
  const project = selected && projects.find(project => project.fullPath === selected.projectKey || project.name === selected.projectKey);
  return <div className="cron-workspace">
    {sidebar ? sidebar.host && createPortal(list, sidebar.host) : <aside className="cron-standalone-sidebar">{list}</aside>}
    <div className="cron-result-workspace">
      <header className="workspace-header cron-workspace-header">
        {isSidebarCollapsed && <button type="button" className="cron-icon-button" onClick={onOpenSidebar} aria-label={t('cron.workspace.showTasks', { defaultValue: 'Show task list' })}><PanelLeftOpen size={18} /></button>}
        <div className="min-w-0 flex-1"><h1>{selected?.name || selected?.prompt.split('\n')[0] || t('cron.title', { defaultValue: 'Scheduled tasks' })}</h1>
          {selected && <p className="cron-workspace-subtitle">{project?.displayName || project?.name || selected.projectKey} · {cronScheduleLabel(selected.schedule, selected.timezone, t)}</p>}
        </div>
        {selected && <CronTaskActions key={selected.id} job={selected} onEdit={edit} onRefresh={refresh} onError={setError} onDeleted={deleted} onRunStarted={() => setLatestRunRequest(value => value + 1)} />}
      </header>
      {error && <p role="alert" className="cron-workspace-error">{error}</p>}
      {selected ? <CronTaskDetails key={selected.id} job={selected} projects={projects} onRefresh={refresh} onEdit={() => edit(selected)} latestRunRequest={latestRunRequest} />
        : <div className="cron-workspace-empty"><span className="cron-empty-icon"><CalendarClock size={30} strokeWidth={1.35} /></span>
          <h2>{t(requestedId ? 'cron.workspace.notFound' : 'cron.workspace.emptyTitle', { defaultValue: requestedId ? 'This task is unavailable' : 'Make room for recurring work' })}</h2>
          <p>{t(requestedId ? 'cron.workspace.notFoundHint' : 'cron.workspace.emptyHint', { defaultValue: requestedId ? 'Refresh the task list or choose another task.' : 'Schedule a task once. Find its next run and every result here.' })}</p>
          <button type="button" className="cron-button primary" onClick={() => setEditor({ job: null })}><Plus size={15} />{t('cron.workspace.newTask', { defaultValue: 'New task' })}</button>
        </div>}
    </div>
    {editor && <CronTaskEditor key={editor.job?.id || 'create'} t={t} projects={projects} editingJob={editor.job} onCancel={() => setEditor(null)} onCompleted={async taskId => {
      await refresh(); if (taskId) setParams({ taskId }, { replace: true }); setEditor(null); sidebar?.onSelect();
    }} />}
  </div>;
}
