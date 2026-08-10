import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ReactDOM from 'react-dom';
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  Info,
  ListChecks,
  Loader2,
  Pencil,
  Play,
  PlusCircle,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import type { CronJobOverview, CronJobSchedule, CronJobsOverviewResponse, Project } from '../../types/app';
import { cn } from '../../lib/utils.js';
import { api } from '../../utils/api';
import {
  buildSimpleCronExpression,
  getYearlyMonthDayCount,
  parseSimpleCronExpression,
  type SimpleCronSchedule,
  type SimpleRecurrenceMode,
} from './cronSchedule';

const POLL_INTERVAL_MS = 15_000;
const HOUR_MS = 60 * 60 * 1000;
const TIMEZONE_OFFSET_SAMPLE_HOURS = [-36, -24, -12, 0, 12, 24, 36] as const;

type CronSubTab = 'list' | 'create';
type ScheduleKind = 'once' | 'cron';
type EditDisabledReason = 'running' | 'unsupported' | 'incomplete';

type CronFormValues = {
  message: string;
  projectKey: string;
  scheduleKind: ScheduleKind;
  scheduleDate: string;
  scheduleTime: string;
  timezone: string;
  recurrenceMode: SimpleRecurrenceMode;
  weekday: number;
  dayOfMonth: number;
  monthOfYear: number;
  advancedExpression: string;
};

type OnceScheduleDraft = Pick<CronFormValues, 'scheduleDate' | 'scheduleTime'>;
type RecurringScheduleDraft = Pick<CronFormValues, 'scheduleTime' | 'recurrenceMode' | 'weekday' | 'dayOfMonth' | 'monthOfYear' | 'advancedExpression'>;

function getSimpleCronSchedule(draft: RecurringScheduleDraft): SimpleCronSchedule {
  switch (draft.recurrenceMode) {
    case 'daily':
      return { mode: 'daily', time: draft.scheduleTime };
    case 'weekly':
      return { mode: 'weekly', time: draft.scheduleTime, weekday: draft.weekday };
    case 'monthly':
      return { mode: 'monthly', time: draft.scheduleTime, dayOfMonth: draft.dayOfMonth };
    case 'yearly':
      return { mode: 'yearly', time: draft.scheduleTime, dayOfMonth: draft.dayOfMonth, monthOfYear: draft.monthOfYear };
  }
}

function buildSimpleExpression(draft: RecurringScheduleDraft): string {
  try {
    return buildSimpleCronExpression(getSimpleCronSchedule(draft));
  } catch {
    return '';
  }
}

const SIMPLE_RECURRENCE_MODES: {
  id: SimpleRecurrenceMode;
  labelKey: string;
  defaultLabel: string;
}[] = [
  { id: 'daily', labelKey: 'cron.create.schedule.daily', defaultLabel: 'Daily' },
  { id: 'weekly', labelKey: 'cron.create.schedule.weekly', defaultLabel: 'Weekly' },
  { id: 'monthly', labelKey: 'cron.create.schedule.monthly', defaultLabel: 'Monthly' },
  { id: 'yearly', labelKey: 'cron.create.schedule.yearly', defaultLabel: 'Yearly' },
];

const WEEKDAY_OPTIONS = [
  { value: 1, labelKey: 'cron.create.weekdays.monday', defaultLabel: 'Monday' },
  { value: 2, labelKey: 'cron.create.weekdays.tuesday', defaultLabel: 'Tuesday' },
  { value: 3, labelKey: 'cron.create.weekdays.wednesday', defaultLabel: 'Wednesday' },
  { value: 4, labelKey: 'cron.create.weekdays.thursday', defaultLabel: 'Thursday' },
  { value: 5, labelKey: 'cron.create.weekdays.friday', defaultLabel: 'Friday' },
  { value: 6, labelKey: 'cron.create.weekdays.saturday', defaultLabel: 'Saturday' },
  { value: 0, labelKey: 'cron.create.weekdays.sunday', defaultLabel: 'Sunday' },
] as const;

const MONTH_OPTIONS = [
  { value: 1, labelKey: 'cron.create.months.january', defaultLabel: 'January' },
  { value: 2, labelKey: 'cron.create.months.february', defaultLabel: 'February' },
  { value: 3, labelKey: 'cron.create.months.march', defaultLabel: 'March' },
  { value: 4, labelKey: 'cron.create.months.april', defaultLabel: 'April' },
  { value: 5, labelKey: 'cron.create.months.may', defaultLabel: 'May' },
  { value: 6, labelKey: 'cron.create.months.june', defaultLabel: 'June' },
  { value: 7, labelKey: 'cron.create.months.july', defaultLabel: 'July' },
  { value: 8, labelKey: 'cron.create.months.august', defaultLabel: 'August' },
  { value: 9, labelKey: 'cron.create.months.september', defaultLabel: 'September' },
  { value: 10, labelKey: 'cron.create.months.october', defaultLabel: 'October' },
  { value: 11, labelKey: 'cron.create.months.november', defaultLabel: 'November' },
  { value: 12, labelKey: 'cron.create.months.december', defaultLabel: 'December' },
] as const;

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

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function readDateTimeInTimezone(date: Date, timezone: string): ZonedDateTimeParts | undefined {
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    const values: Record<string, string> = {};
    const formatter = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== 'literal') values[part.type] = part.value;
    }
    const result = {
      year: Number.parseInt(values.year, 10),
      month: Number.parseInt(values.month, 10),
      day: Number.parseInt(values.day, 10),
      hour: Number.parseInt(values.hour, 10),
      minute: Number.parseInt(values.minute, 10),
    };
    return Object.values(result).every(Number.isInteger) ? result : undefined;
  } catch {
    return undefined;
  }
}

function formatDateTimeInTimezone(date: Date, timezone: string): string {
  const parts = readDateTimeInTimezone(date, timezone);
  if (!parts) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    parts.year,
    '-',
    pad(parts.month),
    '-',
    pad(parts.day),
    'T',
    pad(parts.hour),
    ':',
    pad(parts.minute),
  ].join('');
}

function formatDateInTimezone(date: Date, timezone: string): string {
  return formatDateTimeInTimezone(date, timezone).slice(0, 10);
}

function formatTimeInTimezone(date: Date, timezone: string): string {
  return formatDateTimeInTimezone(date, timezone).slice(11, 16);
}

function parseWallTime(scheduleDate: string, scheduleTime: string): ZonedDateTimeParts | undefined {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(scheduleDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(scheduleTime);
  if (!dateMatch || !timeMatch) return undefined;

  const parts = {
    year: Number.parseInt(dateMatch[1], 10),
    month: Number.parseInt(dateMatch[2], 10),
    day: Number.parseInt(dateMatch[3], 10),
    hour: Number.parseInt(timeMatch[1], 10),
    minute: Number.parseInt(timeMatch[2], 10),
  };
  const normalized = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  if (normalized.getUTCFullYear() !== parts.year
    || normalized.getUTCMonth() + 1 !== parts.month
    || normalized.getUTCDate() !== parts.day
    || normalized.getUTCHours() !== parts.hour
    || normalized.getUTCMinutes() !== parts.minute) {
    return undefined;
  }
  return parts;
}

function sameWallTime(left: ZonedDateTimeParts, right: ZonedDateTimeParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

function wallTimeEpoch(parts: ZonedDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function timezoneOffsetAt(epochMs: number, timezone: string): number | undefined {
  const instant = new Date(epochMs);
  const zoned = readDateTimeInTimezone(instant, timezone);
  if (!zoned) return undefined;
  return wallTimeEpoch(zoned) - epochMs;
}

function resolveWallTimeInTimezone(
  scheduleDate: string,
  scheduleTime: string,
  timezone: string,
  referenceEpochMs: number,
): string | undefined {
  if (!isValidTimezone(timezone)) return undefined;
  const requested = parseWallTime(scheduleDate, scheduleTime);
  if (!requested) return undefined;

  const requestedEpoch = wallTimeEpoch(requested);
  const possibleOffsets = new Set<number>();
  for (const hours of TIMEZONE_OFFSET_SAMPLE_HOURS) {
    const offset = timezoneOffsetAt(requestedEpoch + hours * HOUR_MS, timezone);
    if (offset !== undefined) possibleOffsets.add(offset);
  }

  const candidates: number[] = [];
  for (const offset of possibleOffsets) {
    const candidateEpoch = requestedEpoch - offset;
    const candidate = readDateTimeInTimezone(new Date(candidateEpoch), timezone);
    if (candidate && sameWallTime(candidate, requested)) candidates.push(candidateEpoch);
  }
  if (candidates.length === 0) return undefined;

  const orderedCandidates = candidates.sort((left, right) => left - right);
  const selectedCandidate = orderedCandidates.find((candidate) => candidate > referenceEpochMs)
    ?? orderedCandidates[0];

  // During DST fallback, prefer the earliest occurrence that is still in the
  // future. If every occurrence has passed, return the earliest one so the
  // caller can report the normal "must be in the future" validation error.
  return new Date(selectedCandidate).toISOString();
}

function resolveOneTimeRunAt(
  editingJob: CronJobOverview | null,
  scheduleDate: string,
  scheduleTime: string,
  timezone: string,
): string | undefined {
  if (editingJob?.schedule?.type === 'once') {
    const original = new Date(editingJob.schedule.runAt);
    if (!Number.isNaN(original.getTime())
      && formatDateInTimezone(original, timezone) === scheduleDate
      && formatTimeInTimezone(original, timezone) === scheduleTime) {
      return editingJob.schedule.runAt;
    }
  }

  return resolveWallTimeInTimezone(scheduleDate, scheduleTime, timezone, Date.now());
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

function getDefaultFormValues(): CronFormValues {
  const defaultRunAt = new Date(Date.now() + 60 * 60 * 1000);
  const timezone = getBrowserTimezone();
  const scheduleTime = formatTimeInTimezone(defaultRunAt, timezone);
  return {
    message: '',
    projectKey: '',
    scheduleKind: 'once',
    scheduleDate: formatDateInTimezone(defaultRunAt, timezone),
    scheduleTime,
    timezone,
    recurrenceMode: 'daily',
    weekday: defaultRunAt.getDay(),
    dayOfMonth: defaultRunAt.getDate(),
    monthOfYear: defaultRunAt.getMonth() + 1,
    advancedExpression: buildSimpleCronExpression({ mode: 'daily', time: scheduleTime }),
  };
}

function getFormValues(job: CronJobOverview | null): CronFormValues {
  const defaults = getDefaultFormValues();
  if (!job?.schedule || !job.projectKey) return defaults;

  const timezone = job.timezone?.trim()
    || (job.schedule.type === 'cron' ? job.schedule.timezone?.trim() : '')
    || defaults.timezone;
  if (job.schedule.type === 'once') {
    const runAt = new Date(job.schedule.runAt);
    if (Number.isNaN(runAt.getTime())) return defaults;
    const displayTimezone = isValidTimezone(timezone) ? timezone : defaults.timezone;
    const scheduleTime = formatTimeInTimezone(runAt, displayTimezone);
    return {
      ...defaults,
      message: job.prompt,
      projectKey: job.projectKey,
      scheduleKind: 'once',
      scheduleDate: formatDateInTimezone(runAt, displayTimezone),
      scheduleTime,
      timezone,
      advancedExpression: buildSimpleCronExpression({ mode: 'daily', time: scheduleTime }),
    };
  }

  const parsed = parseSimpleCronExpression(job.schedule.expression);
  if (!parsed) return defaults;
  const values: CronFormValues = {
    ...defaults,
    message: job.prompt,
    projectKey: job.projectKey,
    scheduleKind: 'cron',
    scheduleTime: parsed.time,
    timezone,
    recurrenceMode: parsed.mode,
    advancedExpression: buildSimpleCronExpression(parsed),
  };
  if (parsed.mode === 'weekly') {
    values.weekday = parsed.weekday;
  } else if (parsed.mode === 'monthly') {
    values.dayOfMonth = parsed.dayOfMonth;
  } else if (parsed.mode === 'yearly') {
    values.dayOfMonth = parsed.dayOfMonth;
    values.monthOfYear = parsed.monthOfYear;
  }
  return values;
}

function getEditDisabledReason(job: CronJobOverview): EditDisabledReason | null {
  if (job.status === 'running') return 'running';
  if (job.status !== 'scheduled' || !job.projectKey || typeof job.revision !== 'number' || !Number.isInteger(job.revision) || job.revision < 0) {
    return 'incomplete';
  }
  if (!job.schedule) return 'incomplete';
  if (job.schedule.type === 'once') {
    return Number.isNaN(Date.parse(job.schedule.runAt)) ? 'unsupported' : null;
  }
  return parseSimpleCronExpression(job.schedule.expression) ? null : 'unsupported';
}

function addCalendarDay(scheduleDate: string): string {
  const [year, month, day] = scheduleDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function getNextFutureDateForTime(time: string, timezone: string): string {
  const now = new Date();
  const resolvedTimezone = isValidTimezone(timezone) ? timezone : getBrowserTimezone();
  const today = formatDateInTimezone(now, resolvedTimezone);
  const candidate = resolveWallTimeInTimezone(today, time, resolvedTimezone, now.getTime());
  if (!candidate || Date.parse(candidate) <= now.getTime()) return addCalendarDay(today);
  return today;
}

export default function CronV2() {
  const { t } = useTranslation('alwaysOn');
  const [subTab, setSubTab] = useState<CronSubTab>('list');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<CronJobOverview[]>([]);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [editingJob, setEditingJob] = useState<CronJobOverview | null>(null);

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
              onClick={() => {
                if (tab.id === 'list' || subTab !== 'create') setEditingJob(null);
                setSubTab(tab.id);
              }}
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
            onEdit={(job) => {
              setEditingJob(job);
              setSubTab('create');
            }}
          />
        ) : (
          <CronCreateView
            key={editingJob?.id || 'create'}
            t={t}
            projects={projects}
            editingJob={editingJob}
            onCompleted={async () => {
              await refresh();
              setEditingJob(null);
              setSubTab('list');
            }}
            onCancel={() => {
              setEditingJob(null);
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
  onEdit,
}: {
  t: (key: string, opts?: Record<string, string>) => string;
  loading: boolean;
  error: string | null;
  grouped: Map<string, ProjectGroup>;
  totalItems: number;
  collapsedProjects: Set<string>;
  onRefresh: () => Promise<void>;
  onToggleProject: (key: string) => void;
  onEdit: (job: CronJobOverview) => void;
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
                          onEdit={onEdit}
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
  editingJob,
  onCompleted,
  onCancel,
}: {
  t: (key: string, opts?: Record<string, string>) => string;
  projects: Project[];
  editingJob: CronJobOverview | null;
  onCompleted: () => Promise<void>;
  onCancel: () => void;
}) {
  const initialValues = useMemo(() => getFormValues(editingJob), [editingJob]);
  const isEditing = editingJob !== null;
  const [message, setMessage] = useState(initialValues.message);
  const [projectKey, setProjectKey] = useState(initialValues.projectKey);
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(initialValues.scheduleKind);
  const [onceDraft, setOnceDraft] = useState<OnceScheduleDraft>({
    scheduleDate: initialValues.scheduleDate,
    scheduleTime: initialValues.scheduleTime,
  });
  const [recurringDraft, setRecurringDraft] = useState<RecurringScheduleDraft>({
    scheduleTime: initialValues.scheduleTime,
    recurrenceMode: initialValues.recurrenceMode,
    weekday: initialValues.weekday,
    dayOfMonth: initialValues.dayOfMonth,
    monthOfYear: initialValues.monthOfYear,
    advancedExpression: initialValues.advancedExpression,
  });
  const [hasOnceDraft, setHasOnceDraft] = useState(initialValues.scheduleKind === 'once');
  const [hasRecurringDraft, setHasRecurringDraft] = useState(initialValues.scheduleKind === 'cron');
  const [timezone, setTimezone] = useState(initialValues.timezone);
  const [advancedExpanded, setAdvancedExpanded] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const projectOptionExists = projects.some((project) => (project.fullPath || project.name) === projectKey);
  const { scheduleTime, recurrenceMode, weekday, dayOfMonth, monthOfYear, advancedExpression } = recurringDraft;

  const parsedAdvancedExpression = useMemo(
    () => parseSimpleCronExpression(advancedExpression),
    [advancedExpression],
  );
  const advancedExpressionIsValid = parsedAdvancedExpression !== undefined;
  const normalizedAdvancedExpression = parsedAdvancedExpression
    ? buildSimpleCronExpression(parsedAdvancedExpression)
    : '';

  const updateRecurringDraft = (updates: Partial<RecurringScheduleDraft>) => {
    setRecurringDraft((current) => {
      const next = { ...current, ...updates };
      return { ...next, advancedExpression: buildSimpleExpression(next) };
    });
    setHasRecurringDraft(true);
  };

  const scheduleDescription = useMemo(() => {
    switch (recurrenceMode) {
      case 'daily':
        return t('cron.create.plan.daily', { defaultValue: 'Daily at {{time}}', time: scheduleTime });
      case 'weekly': {
        const option = WEEKDAY_OPTIONS.find((item) => item.value === weekday) ?? WEEKDAY_OPTIONS[0];
        return t('cron.create.plan.weekly', {
          defaultValue: 'Every {{weekday}} at {{time}}',
          weekday: t(option.labelKey, { defaultValue: option.defaultLabel }),
          time: scheduleTime,
        });
      }
      case 'monthly':
        return t('cron.create.plan.monthly', { defaultValue: 'Monthly on day {{day}} at {{time}}', day: String(dayOfMonth), time: scheduleTime });
      case 'yearly':
        return t('cron.create.plan.yearly', { defaultValue: 'Yearly on {{month}}/{{day}} at {{time}}', month: String(monthOfYear), day: String(dayOfMonth), time: scheduleTime });
    }
  }, [dayOfMonth, monthOfYear, recurrenceMode, scheduleTime, t, weekday]);
  const scheduleDescriptionWithTimezone = timezone.trim()
    ? `${scheduleDescription} (${timezone.trim()})`
    : scheduleDescription;
  const scheduleNotice = recurrenceMode === 'monthly' && dayOfMonth >= 29
    ? t('cron.create.help.monthlyDateMayBeSkipped', { defaultValue: 'Months without this date will not trigger the task.' })
    : recurrenceMode === 'yearly' && monthOfYear === 2 && dayOfMonth === 29
      ? t('cron.create.help.yearlyLeapDay', { defaultValue: 'This task will only trigger in leap years.' })
      : null;

  const resetForm = () => {
    const defaults = getDefaultFormValues();
    setMessage(defaults.message);
    setProjectKey(defaults.projectKey);
    setScheduleKind(defaults.scheduleKind);
    setOnceDraft({ scheduleDate: defaults.scheduleDate, scheduleTime: defaults.scheduleTime });
    setRecurringDraft({
      scheduleTime: defaults.scheduleTime,
      recurrenceMode: defaults.recurrenceMode,
      weekday: defaults.weekday,
      dayOfMonth: defaults.dayOfMonth,
      monthOfYear: defaults.monthOfYear,
      advancedExpression: defaults.advancedExpression,
    });
    setHasOnceDraft(true);
    setHasRecurringDraft(false);
    setTimezone(defaults.timezone);
    setAdvancedExpanded(true);
  };

  const handleScheduleKindChange = (kind: ScheduleKind) => {
    if (kind === scheduleKind) return;
    setFormError(null);
    if (kind === 'cron' && !hasRecurringDraft) {
      const nextDraft: RecurringScheduleDraft = {
        ...recurringDraft,
        scheduleTime: onceDraft.scheduleTime,
        recurrenceMode: 'daily',
      };
      setRecurringDraft({ ...nextDraft, advancedExpression: buildSimpleExpression(nextDraft) });
      setHasRecurringDraft(true);
    } else if (kind === 'once' && !hasOnceDraft) {
      setOnceDraft({
        scheduleDate: getNextFutureDateForTime(recurringDraft.scheduleTime, timezone.trim()),
        scheduleTime: recurringDraft.scheduleTime,
      });
      setHasOnceDraft(true);
    }
    setScheduleKind(kind);
  };

  const handleExpressionChange = (expression: string) => {
    setFormError(null);
    const parsed = parseSimpleCronExpression(expression);
    setRecurringDraft((current) => {
      if (!parsed) return { ...current, advancedExpression: expression };
      return {
        ...current,
        advancedExpression: expression,
        scheduleTime: parsed.time,
        recurrenceMode: parsed.mode,
        weekday: parsed.mode === 'weekly' ? parsed.weekday : current.weekday,
        dayOfMonth: parsed.mode === 'monthly' || parsed.mode === 'yearly' ? parsed.dayOfMonth : current.dayOfMonth,
        monthOfYear: parsed.mode === 'yearly' ? parsed.monthOfYear : current.monthOfYear,
      };
    });
    setHasRecurringDraft(true);
  };

  const validate = () => {
    if (!message.trim()) {
      return t('cron.create.validation.messageRequired', { defaultValue: 'Prompt is required.' });
    }
    if (!projectKey) {
      return t('cron.create.validation.workspaceRequired', { defaultValue: 'Workspace is required.' });
    }
    if (scheduleKind === 'once' && !onceDraft.scheduleTime) {
      return t('cron.create.validation.timeRequired', { defaultValue: 'Time is required.' });
    }
    if (!timezone.trim()) {
      return t('cron.create.validation.timezoneRequired', { defaultValue: 'Timezone is required.' });
    }
    if (!isValidTimezone(timezone.trim())) {
      return t('cron.create.validation.timezoneInvalid', { defaultValue: 'Timezone is invalid.' });
    }
    if (scheduleKind === 'once') {
      if (!onceDraft.scheduleDate) {
        return t('cron.create.validation.dateRequired', { defaultValue: 'Date is required.' });
      }
      const runAt = resolveOneTimeRunAt(
        editingJob,
        onceDraft.scheduleDate,
        onceDraft.scheduleTime,
        timezone.trim(),
      );
      if (!runAt) {
        return t('cron.create.validation.runAtInvalid', { defaultValue: 'Run time does not exist in the selected timezone.' });
      }
      if (Date.parse(runAt) <= Date.now()) {
        return t('cron.create.validation.runAtFuture', { defaultValue: 'Run time must be in the future.' });
      }
    } else {
      if (!scheduleTime) {
        return t('cron.create.validation.timeRequired', { defaultValue: 'Time is required.' });
      }
      if (!advancedExpressionIsValid) {
        return t('cron.create.validation.expressionInvalid', { defaultValue: 'Cron expression format is invalid.' });
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
      const isExpressionValidationError = scheduleKind === 'cron'
        && !advancedExpressionIsValid
        && validationError === t('cron.create.validation.expressionInvalid', { defaultValue: 'Cron expression format is invalid.' });
      if (isExpressionValidationError) {
        setAdvancedExpanded(true);
        setFormError(null);
      } else {
        setFormError(validationError);
      }
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      let schedule: CronJobSchedule;
      if (scheduleKind === 'once') {
        const runAt = resolveOneTimeRunAt(
          editingJob,
          onceDraft.scheduleDate,
          onceDraft.scheduleTime,
          timezone.trim(),
        );
        if (!runAt) {
          setFormError(t('cron.create.validation.runAtInvalid', { defaultValue: 'Run time does not exist in the selected timezone.' }));
          return;
        }
        schedule = { type: 'once', runAt };
      } else {
        schedule = {
          type: 'cron',
          expression: normalizedAdvancedExpression,
          timezone: timezone.trim(),
        };
      }
      const payload = {
        message: message.trim(),
        projectKey,
        schedule,
        timezone: timezone.trim() || undefined,
      };
      const response = editingJob
        ? await api.cronUpdate(editingJob.id, { ...payload, expectedRevision: editingJob.revision })
        : await api.cronCreate(payload);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
        if (editingJob) {
          const conflictMarker = `${body.code || ''} ${body.error || ''}`.toLowerCase();
          if (response.status === 409 && conflictMarker.includes('running')) {
            setFormError(t('cron.edit.errors.running', { defaultValue: 'Stop the running task before saving changes.' }));
          } else if (response.status === 409) {
            setFormError(t('cron.edit.errors.conflict', { defaultValue: 'This task has changed. Refresh the list and edit it again.' }));
          } else {
            setFormError(t('cron.edit.errors.saveFailed', { defaultValue: 'Failed to save cron task changes.' }));
          }
          return;
        }
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      if (!editingJob) {
        resetForm();
        setSuccess(t('cron.create.success', { defaultValue: 'Cron task created.' }));
      }
      await onCompleted();
    } catch (caught) {
      setFormError(editingJob
        ? t('cron.edit.errors.saveFailed', { defaultValue: 'Failed to save cron task changes.' })
        : caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full space-y-5 px-8 py-5">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          {isEditing
            ? t('cron.edit.title', { defaultValue: 'Edit Cron Task' })
            : t('cron.create.title', { defaultValue: 'Create Cron Task' })}
        </h2>
        <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
          {isEditing
            ? t('cron.edit.subtitle', { defaultValue: 'Update the prompt or schedule for this task.' })
            : t('cron.create.subtitle', { defaultValue: 'Schedule a one-time or recurring background prompt.' })}
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
            disabled={isEditing}
            className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950 dark:disabled:bg-neutral-900 dark:disabled:text-neutral-400"
          >
            <option value="">{t('cron.create.placeholders.workspace', { defaultValue: 'Select a workspace' })}</option>
            {isEditing && projectKey && !projectOptionExists ? <option value={projectKey}>{projectKey}</option> : null}
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
                onClick={() => handleScheduleKindChange(kind)}
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

        {scheduleKind === 'once' ? (
          <div className="grid gap-4 md:grid-cols-[1fr_1fr_260px]">
            <label className="block">
              <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                {t('cron.create.fields.date', { defaultValue: 'Date' })}
              </span>
              <input
                type="date"
                value={onceDraft.scheduleDate}
                min={formatDateInTimezone(
                  new Date(),
                  isValidTimezone(timezone.trim()) ? timezone.trim() : getBrowserTimezone(),
                )}
                onChange={(event) => {
                  setOnceDraft((current) => ({ ...current, scheduleDate: event.target.value }));
                  setHasOnceDraft(true);
                }}
                className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
              />
            </label>
            <label className="block">
              <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                {t('cron.create.fields.time', { defaultValue: 'Time' })}
              </span>
              <input
                type="time"
                value={onceDraft.scheduleTime}
                onChange={(event) => {
                  setOnceDraft((current) => ({ ...current, scheduleTime: event.target.value }));
                  setHasOnceDraft(true);
                }}
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
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block min-w-0">
                <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                  {t('cron.create.fields.repeatPeriod', { defaultValue: 'Repeat period' })}
                </span>
                <select
                  value={recurrenceMode}
                  onChange={(event) => {
                    const nextMode = event.target.value as SimpleRecurrenceMode;
                    updateRecurringDraft({
                      recurrenceMode: nextMode,
                      dayOfMonth: nextMode === 'yearly' ? Math.min(dayOfMonth, getYearlyMonthDayCount(monthOfYear)) : dayOfMonth,
                    });
                  }}
                  className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
                >
                  {SIMPLE_RECURRENCE_MODES.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {t(mode.labelKey, { defaultValue: mode.defaultLabel })}
                    </option>
                  ))}
                </select>
              </label>

              <div className="min-w-0">
                <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                  {t('cron.create.fields.executionDay', { defaultValue: 'Execution day' })}
                </span>
                {recurrenceMode === 'daily' ? (
                  <div className="mt-1.5 flex h-9 items-center rounded-md border border-neutral-200 bg-neutral-50 px-3 text-[13px] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
                    {t('cron.create.options.everyDay', { defaultValue: 'Every day' })}
                  </div>
                ) : recurrenceMode === 'weekly' ? (
                  <select
                    aria-label={t('cron.create.fields.weekday', { defaultValue: 'Day of week' })}
                    value={weekday}
                    onChange={(event) => updateRecurringDraft({ weekday: Number(event.target.value) })}
                    className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
                  >
                    {WEEKDAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey, { defaultValue: option.defaultLabel })}
                      </option>
                    ))}
                  </select>
                ) : recurrenceMode === 'monthly' ? (
                  <select
                    aria-label={t('cron.create.fields.monthDay', { defaultValue: 'Day of month' })}
                    value={dayOfMonth}
                    onChange={(event) => updateRecurringDraft({ dayOfMonth: Number(event.target.value) })}
                    className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
                  >
                    {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                      <option key={day} value={day}>{day}</option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    <select
                      aria-label={t('cron.create.fields.month', { defaultValue: 'Month' })}
                      value={monthOfYear}
                      onChange={(event) => {
                        const nextMonth = Number(event.target.value);
                        updateRecurringDraft({
                          monthOfYear: nextMonth,
                          dayOfMonth: Math.min(dayOfMonth, getYearlyMonthDayCount(nextMonth)),
                        });
                      }}
                      className="h-9 min-w-0 rounded-md border border-neutral-200 bg-white px-2 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
                    >
                      {MONTH_OPTIONS.map((month) => (
                        <option key={month.value} value={month.value}>
                          {t(month.labelKey, { defaultValue: month.defaultLabel })}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={t('cron.create.fields.monthDay', { defaultValue: 'Day of month' })}
                      value={dayOfMonth}
                      onChange={(event) => updateRecurringDraft({ dayOfMonth: Number(event.target.value) })}
                      className="h-9 min-w-0 rounded-md border border-neutral-200 bg-white px-2 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
                    >
                      {Array.from({ length: getYearlyMonthDayCount(monthOfYear) }, (_, index) => index + 1).map((day) => (
                        <option key={day} value={day}>{day}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <label className="block min-w-0">
                <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                  {t('cron.create.fields.time', { defaultValue: 'Time' })}
                </span>
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(event) => updateRecurringDraft({ scheduleTime: event.target.value })}
                  className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
                />
              </label>

              <label className="block min-w-0">
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

            <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">
                {t('cron.create.plan.label', { defaultValue: 'Plan:' })}
              </span>{' '}
              {scheduleDescriptionWithTimezone}
            </p>
            {scheduleNotice ? (
              <p aria-live="polite" className="text-[12px] text-neutral-500 dark:text-neutral-400">
                {scheduleNotice}
              </p>
            ) : null}

            <div className="rounded-lg border border-blue-200 bg-blue-50/30 p-3 dark:border-blue-900 dark:bg-blue-950/20">
              <button
                type="button"
                aria-expanded={advancedExpanded}
                onClick={() => setAdvancedExpanded((current) => !current)}
                className="flex w-full items-center justify-between text-left text-[13px] font-medium text-neutral-800 dark:text-neutral-200"
              >
                <span>{t('cron.create.schedule.advanced', { defaultValue: 'Advanced Cron expression' })}</span>
                <span className="inline-flex items-center gap-1 text-[12px] font-normal text-blue-600 dark:text-blue-400">
                  {advancedExpanded
                    ? t('cron.create.actions.collapseAdvanced', { defaultValue: 'Collapse' })
                    : t('cron.create.actions.expandAdvanced', { defaultValue: 'Expand' })}
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', advancedExpanded && 'rotate-180')} strokeWidth={1.75} />
                </span>
              </button>

              {advancedExpanded ? (
                <div className="mt-3 min-w-0">
                  <label className="block">
                    <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                      {t('cron.create.fields.expression', { defaultValue: 'Cron expression' })}
                    </span>
                    <input
                      value={advancedExpression}
                      onChange={(event) => handleExpressionChange(event.target.value)}
                      aria-invalid={!advancedExpressionIsValid}
                      aria-describedby={advancedExpressionIsValid
                        ? 'cron-expression-format cron-expression-plan'
                        : 'cron-expression-format cron-expression-feedback'}
                      placeholder={t('cron.create.placeholders.expression', { defaultValue: '30 8 * * 1' })}
                      className="mt-1.5 h-9 w-full rounded-md border border-neutral-200 bg-white px-3 font-mono text-[13px] text-neutral-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-blue-500 dark:focus:ring-blue-950"
                    />
                  </label>
                  <p id="cron-expression-format" className="mt-1.5 text-[12px] text-neutral-500 dark:text-neutral-400">
                    {t('cron.create.help.expressionFormat', { defaultValue: 'Format: minute hour day month weekday' })}
                  </p>
                  {!advancedExpressionIsValid ? (
                    <p id="cron-expression-feedback" aria-live="polite" className="mt-1.5 text-[12px] text-red-600 dark:text-red-400">
                      {t('cron.create.validation.expressionInvalid', { defaultValue: 'Cron expression format is invalid.' })}
                    </p>
                  ) : (
                    <p id="cron-expression-plan" aria-live="polite" className="mt-1.5 flex items-center gap-1.5 text-[12px] text-neutral-500 dark:text-neutral-400">
                      <Info className="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" strokeWidth={1.75} />
                      <span>
                        <span className="font-medium">
                          {t('cron.create.plan.currentLabel', { defaultValue: 'Current plan:' })}
                        </span>{' '}
                        {scheduleDescriptionWithTimezone}
                      </span>
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {isEditing ? (
            <button
              type="button"
              disabled={submitting}
              onClick={onCancel}
              className="inline-flex h-8 items-center justify-center rounded-md border border-neutral-200 bg-white px-3 text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900"
            >
              {t('cron.edit.actions.cancel', { defaultValue: 'Cancel' })}
            </button>
          ) : null}
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-[12px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : isEditing ? <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} /> : <PlusCircle className="h-3.5 w-3.5" strokeWidth={1.75} />}
            {isEditing
              ? t('cron.edit.actions.save', { defaultValue: 'Save Changes' })
              : t('cron.create.actions.submit', { defaultValue: 'Create Task' })}
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
  onEdit,
}: {
  job: CronJobOverview;
  t: (key: string, opts?: Record<string, string>) => string;
  onRefresh: () => Promise<void>;
  onEdit: (job: CronJobOverview) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const status = job.status === 'running' ? 'running' : 'scheduled';
  const meta = CRON_STATUS_LABEL[status];
  const editDisabledReason = getEditDisabledReason(job);
  const editTitle = editDisabledReason === 'running'
    ? t('cron.edit.disabled.running', { defaultValue: 'Stop the running task before editing.' })
    : editDisabledReason === 'unsupported'
      ? t('cron.edit.disabled.unsupported', { defaultValue: 'This task uses a schedule that cannot be edited on this page.' })
      : editDisabledReason === 'incomplete'
        ? t('cron.edit.disabled.incomplete', { defaultValue: 'This task is missing the details required for editing.' })
        : t('cron.actions.edit', { defaultValue: 'Edit' });

  const runAction = async (action: 'runNow' | 'stop') => {
    if (busy) return;
    setBusy(true);
    try {
      const response = action === 'runNow'
        ? await api.cronRunNow(job.id)
        : await api.cronStop(job.id);
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

  const openDeleteDialog = () => {
    if (busy) return;
    setDeleteError(null);
    setDeleteDialogOpen(true);
  };

  const closeDeleteDialog = () => {
    if (busy) return;
    setDeleteDialogOpen(false);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (busy) return;
    setBusy(true);
    setDeleteError(null);
    try {
      const response = await api.cronDelete(job.id);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      setDeleteDialogOpen(false);
      await onRefresh();
    } catch (caught) {
      setDeleteError(caught instanceof Error
        ? caught.message
        : t('cron.deleteConfirm.failed', { defaultValue: 'Failed to delete cron task.' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-4 px-5 py-2.5 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/40">
        <div className={cn(COL.title, 'truncate text-[13px] text-neutral-900 dark:text-neutral-100')}>
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
          <span className="inline-flex" title={editTitle}>
            <button
              type="button"
              disabled={busy || editDisabledReason !== null}
              onClick={() => onEdit(job)}
              className="inline-flex h-7 items-center rounded-md border border-neutral-200 px-2 text-neutral-500 transition hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-blue-700 dark:hover:text-blue-400"
              aria-label={t('cron.actions.edit', { defaultValue: 'Edit' })}
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={openDeleteDialog}
            className="inline-flex h-7 items-center rounded-md border border-neutral-200 px-2 text-neutral-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-red-700 dark:hover:text-red-400"
            title={t('cron.actions.delete', { defaultValue: 'Delete' })}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {deleteDialogOpen
        ? ReactDOM.createPortal(
            <DeleteCronJobDialog
              job={job}
              t={t}
              busy={busy}
              error={deleteError}
              onCancel={closeDeleteDialog}
              onConfirm={() => void confirmDelete()}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function DeleteCronJobDialog({
  job,
  t,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  job: CronJobOverview;
  t: (key: string, opts?: Record<string, string>) => string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const prompt = job.prompt?.trim() || '';
  const promptPreview = prompt.length > 160 ? `${prompt.slice(0, 160)}…` : prompt || '—';

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;

    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const firstButton = buttons[0];
    const lastButton = buttons.at(-1);
    if (!firstButton || !lastButton) return;

    if (event.shiftKey && document.activeElement === firstButton) {
      event.preventDefault();
      lastButton.focus();
    } else if (!event.shiftKey && document.activeElement === lastButton) {
      event.preventDefault();
      firstButton.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="delete-cron-job-title" onKeyDown={handleKeyDown}>
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl">
        <div className="flex items-start gap-3 border-b border-border p-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
            <Trash2 className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="delete-cron-job-title" className="text-base font-semibold text-foreground">
              {t('cron.deleteConfirm.title', { defaultValue: 'Delete cron task?' })}
            </h3>
            <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">
              {promptPreview}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          <p className="text-sm text-foreground">
            {t('cron.deleteConfirm.description', { defaultValue: 'This cron task will be permanently deleted.' })}
          </p>
          {error ? (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            autoFocus
            className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            {t('cron.deleteConfirm.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" strokeWidth={1.75} />}
            {busy
              ? t('cron.deleteConfirm.deleting', { defaultValue: 'Deleting…' })
              : t('cron.deleteConfirm.confirm', { defaultValue: 'Delete' })}
          </button>
        </div>
      </div>
    </div>
  );
}
