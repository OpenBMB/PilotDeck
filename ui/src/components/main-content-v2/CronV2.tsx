import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  ListChecks,
  Loader2,
  Play,
  PlusCircle,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import type { CronJobOverview, CronJobsOverviewResponse, Project } from '../../types/app';
import { cn } from '../../lib/utils.js';
import { api } from '../../utils/api';

const POLL_INTERVAL_MS = 15_000;

type CronSubTab = 'list' | 'create';
type ScheduleKind = 'once' | 'cron';

const SUB_TABS: { id: CronSubTab; labelKey: string; defaultLabel: string; icon: typeof ListChecks }[] = [
  { id: 'list', labelKey: 'cron.tabs.list', defaultLabel: 'Task List', icon: ListChecks },
  { id: 'create', labelKey: 'cron.tabs.create', defaultLabel: 'Create Task', icon: PlusCircle },
];

const COL = {
  title: 'min-w-0 flex-1 max-w-[420px]',
  createdAt: 'w-[150px] shrink-0',
  nextRunAt: 'w-[150px] shrink-0',
  status: 'w-[140px] shrink-0',
  actions: 'w-[180px] shrink-0',
} as const;

const CRON_STATUS_STYLE: Record<'scheduled' | 'running', string> = {
  scheduled: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  running: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
};

const CRON_STATUS_LABEL: Record<'scheduled' | 'running', { key: string; defaultValue: string }> = {
  scheduled: { key: 'cron.status.scheduled', defaultValue: 'Scheduled' },
  running: { key: 'cron.status.running', defaultValue: 'Running' },
};

type ProjectGroup = {
  displayName: string;
  items: CronJobOverview[];
};

function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}

function formatDateLocal(date: Date): string {
  return formatDateTimeLocal(date).slice(0, 10);
}

function formatTimeLocal(date: Date): string {
  return formatDateTimeLocal(date).slice(11, 16);
}

function buildDailyCronExpression(time: string): string {
  const [hour = '0', minute = '0'] = time.split(':');
  return `${Number(minute)} ${Number(hour)} * * *`;
}

function formatAbsoluteTime(iso: string | number): string {
  const parsed = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function CronV2() {
  const { t } = useTranslation('alwaysOn');
  const [subTab, setSubTab] = useState<CronSubTab>('list');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<CronJobOverview[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projectsRes, jobsRes] = await Promise.all([
        api.projects(),
        api.allCronJobs(),
      ]);

      if (!projectsRes.ok) throw new Error(`Projects: HTTP ${projectsRes.status}`);
      if (!jobsRes.ok) throw new Error(`Cron jobs: HTTP ${jobsRes.status}`);

      const projectsPayload = await projectsRes.json() as Project[];
      const jobsPayload = await jobsRes.json() as CronJobsOverviewResponse;
      setProjects(Array.isArray(projectsPayload) ? projectsPayload : []);
      setJobs(Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const grouped = useMemo(() => {
    const projectMap = new Map<string, Project>();
    const projectKeyToName = new Map<string, string>();
    for (const project of projects) {
      projectMap.set(project.name, project);
      projectKeyToName.set(project.name, project.name);
      if (project.fullPath) projectKeyToName.set(project.fullPath, project.name);
    }

    const result = new Map<string, ProjectGroup>();
    for (const job of jobs) {
      if (job.status !== 'scheduled' && job.status !== 'running') continue;

      const projectName = job.projectKey
        ? (projectKeyToName.get(job.projectKey) || job.projectKey)
        : '__unassigned__';
      const project = projectMap.get(projectName);
      const displayName = project?.displayName || (projectName === '__unassigned__'
        ? t('cron.unassigned', { defaultValue: 'Unassigned' })
        : projectName);

      if (!result.has(projectName)) {
        result.set(projectName, { displayName, items: [] });
      }
      result.get(projectName)!.items.push(job);
    }

    for (const group of result.values()) {
      group.items.sort((left, right) => {
        const leftTime = Date.parse(left.createdAt) || 0;
        const rightTime = Date.parse(right.createdAt) || 0;
        return rightTime - leftTime;
      });
    }

    return result;
  }, [jobs, projects, t]);

  const totalItems = useMemo(() => {
    let count = 0;
    for (const group of grouped.values()) count += group.items.length;
    return count;
  }, [grouped]);

  const toggleProject = (key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      <div className="flex shrink-0 gap-1 border-b border-neutral-200 px-8 pt-4 dark:border-neutral-800">
        {SUB_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = subTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSubTab(tab.id)}
              className={cn(
                'inline-flex items-center gap-1.5 border-b-2 px-3 pb-2 text-[13px] font-medium transition-colors',
                isActive
                  ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200',
              )}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t(tab.labelKey, { defaultValue: tab.defaultLabel })}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {subTab === 'list' ? (
          <CronListView
            t={t}
            loading={loading}
            error={error}
            grouped={grouped}
            totalItems={totalItems}
            collapsedProjects={collapsedProjects}
            onRefresh={refresh}
            onToggleProject={toggleProject}
          />
        ) : (
          <CronCreateView
            t={t}
            projects={projects}
            onCreated={async () => {
              await refresh();
              setSubTab('list');
            }}
          />
        )}
      </div>
    </div>
  );
}

function CronListView({
  t,
  loading,
  error,
  grouped,
  totalItems,
  collapsedProjects,
  onRefresh,
  onToggleProject,
}: {
  t: (key: string, opts?: Record<string, string>) => string;
  loading: boolean;
  error: string | null;
  grouped: Map<string, ProjectGroup>;
  totalItems: number;
  collapsedProjects: Set<string>;
  onRefresh: () => Promise<void>;
  onToggleProject: (key: string) => void;
}) {
  return (
    <div className="w-full space-y-5 px-8 py-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {t('cron.title', { defaultValue: 'Cron' })}
          </h2>
          <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
            {t('cron.subtitle', { defaultValue: 'Scheduled cron jobs across projects.' })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-xxs text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
          <span>{t('actions.refresh', { defaultValue: 'Refresh' })}</span>
        </button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 text-xxs text-red-500">
          <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{error}</span>
        </div>
      ) : null}

      {loading && totalItems === 0 ? (
        <div className="flex items-center gap-2 py-8 text-[13px] text-neutral-500 dark:text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          <span>{t('cron.loading', { defaultValue: 'Loading cron jobs...' })}</span>
        </div>
      ) : totalItems === 0 && !loading ? (
        <div className="py-8 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
          <Clock className="mx-auto mb-2 h-8 w-8 text-neutral-300 dark:text-neutral-600" strokeWidth={1.25} />
          {t('cron.empty', { defaultValue: 'No active cron jobs found.' })}
        </div>
      ) : (
        <div className="space-y-4">
          {[...grouped.entries()].map(([projectKey, group]) => {
            const isCollapsed = collapsedProjects.has(projectKey);
            return (
              <div
                key={projectKey}
                className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
              >
                <button
                  type="button"
                  onClick={() => onToggleProject(projectKey)}
                  className="flex w-full items-center gap-2 px-5 py-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                  )}
                  <span className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
                    {group.displayName}
                  </span>
                  <span className="ml-auto text-xxs tabular-nums text-neutral-400 dark:text-neutral-500">
                    {group.items.length}
                  </span>
                </button>

                {!isCollapsed && (
                  <>
                    <ColumnHeaders t={t} />
                    <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
                      {group.items.map((job) => (
                        <CronJobRow
                          key={job.id}
                          job={job}
                          t={t}
                          onRefresh={onRefresh}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CronCreateView({
  t,
  projects,
  onCreated,
}: {
  t: (key: string, opts?: Record<string, string>) => string;
  projects: Project[];
  onCreated: () => Promise<void>;
}) {
  const defaultRunAt = useMemo(() => new Date(Date.now() + 60 * 60 * 1000), []);
  const [message, setMessage] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('once');
  const [scheduleDate, setScheduleDate] = useState(formatDateLocal(defaultRunAt));
  const [scheduleTime, setScheduleTime] = useState(formatTimeLocal(defaultRunAt));
  const [timezone, setTimezone] = useState(getBrowserTimezone);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const resetForm = () => {
    setMessage('');
    setProjectKey('');
    setScheduleKind('once');
    const nextDefault = new Date(Date.now() + 60 * 60 * 1000);
    setScheduleDate(formatDateLocal(nextDefault));
    setScheduleTime(formatTimeLocal(nextDefault));
    setTimezone(getBrowserTimezone());
  };

  const validate = () => {
    if (!message.trim()) {
      return t('cron.create.validation.messageRequired', { defaultValue: 'Prompt is required.' });
    }
    if (!projectKey) {
      return t('cron.create.validation.workspaceRequired', { defaultValue: 'Workspace is required.' });
    }
    if (!scheduleTime) {
      return t('cron.create.validation.timeRequired', { defaultValue: 'Time is required.' });
    }
    if (!timezone.trim()) {
      return t('cron.create.validation.timezoneRequired', { defaultValue: 'Timezone is required.' });
    }
    if (scheduleKind === 'once') {
      if (!scheduleDate) {
        return t('cron.create.validation.dateRequired', { defaultValue: 'Date is required.' });
      }
      const parsed = new Date(`${scheduleDate}T${scheduleTime}`);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        return t('cron.create.validation.runAtFuture', { defaultValue: 'Run time must be in the future.' });
      }
    }
    return null;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSuccess(null);
    const validationError = validate();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const schedule = scheduleKind === 'once'
        ? { type: 'once', runAt: new Date(`${scheduleDate}T${scheduleTime}`).toISOString() }
        : { type: 'cron', expression: buildDailyCronExpression(scheduleTime), timezone: timezone.trim() };
      const response = await api.cronCreate({
        message: message.trim(),
        projectKey,
        schedule,
        timezone: timezone.trim() || undefined,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      resetForm();
      setSuccess(t('cron.create.success', { defaultValue: 'Cron task created.' }));
      await onCreated();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full space-y-5 px-8 py-5">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          {t('cron.create.title', { defaultValue: 'Create Cron Task' })}
        </h2>
        <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
          {t('cron.create.subtitle', { defaultValue: 'Schedule a one-time or recurring background prompt.' })}
        </p>
      </div>

      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="w-full space-y-5 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950"
      >
        {formError ? (
          <div className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-xxs text-red-600 dark:bg-red-950/40 dark:text-red-300">
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{formError}</span>
          </div>
        ) : success ? (
          <div className="rounded-md bg-emerald-50 px-3 py-2 text-xxs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            {success}
          </div>
        ) : null}

        <label className="block">
          <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
            {t('cron.create.fields.prompt', { defaultValue: 'Prompt' })}
          </span>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={5}
            className="mt-1.5 w-full resize-y rounded-md border border-neutral-200 bg-white px-3 py-2 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
            placeholder={t('cron.create.placeholders.prompt', { defaultValue: 'Describe what PilotDeck should do when this task runs.' })}
          />
        </label>

        <label className="block">
          <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
            {t('cron.create.fields.workspace', { defaultValue: 'Workspace' })}
          </span>
          <select
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
            className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
          >
            <option value="">{t('cron.create.placeholders.workspace', { defaultValue: 'Select a workspace' })}</option>
            {projects.map((project) => (
              <option key={project.fullPath || project.name} value={project.fullPath || project.name}>
                {project.displayName || project.name}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-2.5">
          <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
            {t('cron.create.fields.scheduleType', { defaultValue: 'Schedule Type' })}
          </span>
          <div className="flex w-fit rounded-md border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-800 dark:bg-neutral-900">
            {(['once', 'cron'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setScheduleKind(kind)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded px-3 text-[12px] font-medium transition-colors',
                  scheduleKind === kind
                    ? 'bg-white text-blue-600 shadow-sm dark:bg-neutral-800 dark:text-blue-300'
                    : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100',
                )}
              >
                {kind === 'once' ? <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />}
                {kind === 'once'
                  ? t('cron.create.schedule.once', { defaultValue: 'One-time' })
                  : t('cron.create.schedule.cron', { defaultValue: 'Recurring' })}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[1fr_1fr_260px]">
          <label className="block">
            <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
              {t('cron.create.fields.date', { defaultValue: 'Date' })}
            </span>
            <input
              type="date"
              value={scheduleDate}
              min={formatDateLocal(new Date())}
              disabled={scheduleKind === 'cron'}
              onChange={(event) => setScheduleDate(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950 dark:disabled:bg-neutral-900 dark:disabled:text-neutral-500"
            />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
              {t('cron.create.fields.time', { defaultValue: 'Time' })}
            </span>
            <input
              type="time"
              value={scheduleTime}
              onChange={(event) => setScheduleTime(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
            />
          </label>
          <label className="block">
            <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
              {t('cron.create.fields.timezone', { defaultValue: 'Timezone' })}
            </span>
            <input
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-[12px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <PlusCircle className="h-3.5 w-3.5" strokeWidth={1.75} />}
            {t('cron.create.actions.submit', { defaultValue: 'Create Task' })}
          </button>
        </div>
      </form>
    </div>
  );
}

function ColumnHeaders({ t }: { t: (key: string, opts?: Record<string, string>) => string }) {
  return (
    <div className="flex items-center gap-4 border-b border-neutral-200 bg-neutral-50 px-5 py-2 dark:border-neutral-800 dark:bg-neutral-900/50">
      <div className={COL.title}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('cron.columns.title', { defaultValue: 'Title' })}
        </span>
      </div>
      <div className={COL.createdAt}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('cron.columns.createdAt', { defaultValue: 'Created' })}
        </span>
      </div>
      <div className={COL.nextRunAt}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('cron.columns.nextRunAt', { defaultValue: 'Next Run' })}
        </span>
      </div>
      <div className={COL.status}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('cron.columns.status', { defaultValue: 'Status' })}
        </span>
      </div>
      <div className={COL.actions}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('cron.columns.actions', { defaultValue: 'Actions' })}
        </span>
      </div>
    </div>
  );
}

function CronJobRow({
  job,
  t,
  onRefresh,
}: {
  job: CronJobOverview;
  t: (key: string, opts?: Record<string, string>) => string;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const status = job.status === 'running' ? 'running' : 'scheduled';
  const meta = CRON_STATUS_LABEL[status];

  const runAction = async (action: 'runNow' | 'stop' | 'delete') => {
    if (busy) return;
    setBusy(true);
    try {
      const response = action === 'runNow'
        ? await api.cronRunNow(job.id)
        : action === 'stop'
          ? await api.cronStop(job.id)
          : await api.cronDelete(job.id);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      await onRefresh();
    } catch {
      // The next refresh or global toast surface carries the visible error.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4 px-5 py-2.5 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/40">
      <div className={cn(COL.title, 'truncate text-[13px] text-neutral-900 dark:text-neutral-100')} title={job.prompt || ''}>
        {job.prompt || '—'}
      </div>
      <div className={cn(COL.createdAt, 'font-mono text-xxs tabular-nums text-neutral-500 dark:text-neutral-400')}>
        {formatAbsoluteTime(job.createdAt)}
      </div>
      <div className={cn(COL.nextRunAt, 'font-mono text-xxs tabular-nums text-neutral-500 dark:text-neutral-400')}>
        {job.nextRunAt ? formatAbsoluteTime(job.nextRunAt) || '—' : '—'}
      </div>
      <div className={COL.status}>
        <span className={cn('inline-block rounded-full px-2 py-0.5 text-[11px] font-medium', CRON_STATUS_STYLE[status])}>
          {t(meta.key, { defaultValue: meta.defaultValue })}
        </span>
      </div>
      <div className={cn(COL.actions, 'flex items-center gap-1.5')}>
        {status === 'running' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAction('stop')}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-red-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-red-700 disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
            ) : (
              <>
                <Square className="h-3 w-3" strokeWidth={2} />
                {t('cron.actions.stop', { defaultValue: 'Stop' })}
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAction('runNow')}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-blue-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
            ) : (
              <>
                <Play className="h-3 w-3" strokeWidth={2} />
                {t('cron.actions.runNow', { defaultValue: 'Run Now' })}
              </>
            )}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void runAction('delete')}
          className="inline-flex h-7 items-center rounded-md border border-neutral-200 px-2 text-neutral-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-red-700 dark:hover:text-red-400"
          title={t('cron.actions.delete', { defaultValue: 'Delete' })}
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
