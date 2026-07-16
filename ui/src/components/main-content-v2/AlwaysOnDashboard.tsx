import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  GitMerge,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  XCircle,
  Zap,
} from 'lucide-react';
import type {
  AlwaysOnDashboardEvent,
  AlwaysOnDashboardEventPhase,
  AlwaysOnDashboardEventsResponse,
} from '../../types/app';
import { api } from '../../utils/api';
import { cn } from '../../lib/utils.js';
import RunDetail from './RunDetail';

const POLL_INTERVAL_MS = 15_000;
const EVENT_LIMIT = 200;

const PHASE_META: Record<
  AlwaysOnDashboardEventPhase,
  { icon: typeof Activity; color: string; labelKey: string; defaultLabel: string }
> = {
  discovery_started: {
    icon: Search,
    color: 'text-blue-500 dark:text-blue-400',
    labelKey: 'dashboard.phase.discoveryStarted',
    defaultLabel: 'Discovery Started',
  },
  plan_produced: {
    icon: FileText,
    color: 'text-emerald-600 dark:text-emerald-400',
    labelKey: 'dashboard.phase.planProduced',
    defaultLabel: 'Plan Produced',
  },
  no_plan: {
    icon: Clock,
    color: 'text-neutral-400 dark:text-neutral-500',
    labelKey: 'dashboard.phase.noPlan',
    defaultLabel: 'No Plan',
  },
  workspace_started: {
    icon: Loader2,
    color: 'text-amber-500 dark:text-amber-400',
    labelKey: 'dashboard.phase.workspaceStarted',
    defaultLabel: 'Workspace Preparing',
  },
  workspace_ready: {
    icon: Zap,
    color: 'text-amber-500 dark:text-amber-400',
    labelKey: 'dashboard.phase.workspaceReady',
    defaultLabel: 'Workspace Ready',
  },
  execution_started: {
    icon: Play,
    color: 'text-blue-600 dark:text-blue-400',
    labelKey: 'dashboard.phase.executionStarted',
    defaultLabel: 'Execution Started',
  },
  execution_completed: {
    icon: CheckCircle2,
    color: 'text-emerald-600 dark:text-emerald-400',
    labelKey: 'dashboard.phase.executionCompleted',
    defaultLabel: 'Execution Completed',
  },
  report_started: {
    icon: FileText,
    color: 'text-purple-500 dark:text-purple-400',
    labelKey: 'dashboard.phase.reportStarted',
    defaultLabel: 'Report Generating',
  },
  report_produced: {
    icon: Sparkles,
    color: 'text-purple-600 dark:text-purple-400',
    labelKey: 'dashboard.phase.reportProduced',
    defaultLabel: 'Report Produced',
  },
  apply_started: {
    icon: GitMerge,
    color: 'text-indigo-500 dark:text-indigo-400',
    labelKey: 'dashboard.phase.applyStarted',
    defaultLabel: 'Apply Started',
  },
  apply_completed: {
    icon: CheckCircle2,
    color: 'text-emerald-600 dark:text-emerald-400',
    labelKey: 'dashboard.phase.applyCompleted',
    defaultLabel: 'Apply Completed',
  },
  run_completed: {
    icon: CheckCircle2,
    color: 'text-emerald-600 dark:text-emerald-400',
    labelKey: 'dashboard.phase.runCompleted',
    defaultLabel: 'Run Completed',
  },
  run_failed: {
    icon: XCircle,
    color: 'text-red-500 dark:text-red-400',
    labelKey: 'dashboard.phase.runFailed',
    defaultLabel: 'Run Failed',
  },
  cron_started: {
    icon: Play,
    color: 'text-indigo-500 dark:text-indigo-400',
    labelKey: 'dashboard.phase.cronStarted',
    defaultLabel: 'Cron Started',
  },
  cron_completed: {
    icon: CheckCircle2,
    color: 'text-emerald-600 dark:text-emerald-400',
    labelKey: 'dashboard.phase.cronCompleted',
    defaultLabel: 'Cron Completed',
  },
  cron_failed: {
    icon: XCircle,
    color: 'text-red-500 dark:text-red-400',
    labelKey: 'dashboard.phase.cronFailed',
    defaultLabel: 'Cron Failed',
  },
};

function formatRelativeTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  const diff = Math.max(0, Date.now() - parsed);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function formatAbsoluteTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

const PROJECT_COLORS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
];

function getProjectColor(index: number): string {
  return PROJECT_COLORS[index % PROJECT_COLORS.length]!;
}

function isTerminalPhase(phase: AlwaysOnDashboardEventPhase): boolean {
  return phase === 'run_completed' || phase === 'run_failed' || phase === 'no_plan'
    || phase === 'cron_completed' || phase === 'cron_failed';
}

function isErrorPhase(phase: AlwaysOnDashboardEventPhase): boolean {
  return phase === 'run_failed' || phase === 'cron_failed';
}

type EventClickAction = 'detail' | 'session' | 'none';

function getEventClickAction(phase: AlwaysOnDashboardEventPhase): EventClickAction {
  if (phase === 'plan_produced' || phase === 'report_produced') return 'detail';
  if (phase === 'execution_started' || phase === 'execution_completed') return 'session';
  return 'none';
}

type AlwaysOnDashboardProps = {
  onOpenExecutionSession?: (projectKey: string, runId: string, projectName?: string) => void;
  compact?: boolean;
};

export default function AlwaysOnDashboard({ onOpenExecutionSession, compact = false }: AlwaysOnDashboardProps) {
  const { t } = useTranslation('alwaysOn');
  const [events, setEvents] = useState<AlwaysOnDashboardEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.alwaysOnDashboardEvents(EVENT_LIMIT);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as AlwaysOnDashboardEventsResponse;
      setEvents(Array.isArray(payload.events) ? payload.events : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const projectColorMap = useMemo(() => {
    const map = new Map<string, number>();
    let idx = 0;
    for (const event of events) {
      if (!map.has(event.projectName)) {
        map.set(event.projectName, idx++);
      }
    }
    return map;
  }, [events]);

  const stats = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    let todayEvents = 0;
    const activeProjects = new Set<string>();
    const runningRuns = new Set<string>();

    for (const event of events) {
      if (Date.parse(event.timestamp) >= todayMs) {
        todayEvents++;
      }
      activeProjects.add(event.projectName);
      if (
        event.phase === 'discovery_started' ||
        event.phase === 'execution_started' ||
        event.phase === 'cron_started'
      ) {
        const hasTerminal = events.some(
          (e) => e.runId === event.runId && isTerminalPhase(e.phase),
        );
        if (!hasTerminal) runningRuns.add(event.runId);
      }
    }

    return { todayEvents, activeProjectCount: activeProjects.size, runningCount: runningRuns.size };
  }, [events]);

  const handleEventClick = useCallback(
    (event: AlwaysOnDashboardEvent) => {
      const action = getEventClickAction(event.phase);
      if (action === 'detail') {
        setSelectedRunId(event.runId);
      } else if (action === 'session') {
        onOpenExecutionSession?.(event.projectKey, event.runId, event.projectName);
      }
    },
    [onOpenExecutionSession],
  );

  if (selectedRunId) {
    return (
      <RunDetail
        runId={selectedRunId}
        events={events}
        onBack={() => setSelectedRunId(null)}
        onOpenExecutionSession={onOpenExecutionSession}
        compact={compact}
      />
    );
  }

  return (
    <div className={cn('w-full space-y-5 py-5', compact ? 'px-4' : 'px-8')}>
      <div className={cn('flex items-start justify-between gap-3', compact && 'flex-col')}>
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {t('dashboard.title', { defaultValue: 'Always-On Dashboard' })}
          </h2>
          <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
            {t('dashboard.subtitle', { defaultValue: 'Activity feed across all workspaces.' })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-xxs text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
          <span>{t('actions.refresh', { defaultValue: 'Refresh' })}</span>
        </button>
      </div>

      {/* Stats cards */}
      <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-3')}>
        <div className="rounded-lg border border-neutral-200 p-3.5 dark:border-neutral-800">
          <div className="text-xxs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {t('dashboard.stats.todayEvents', { defaultValue: 'Today\'s Events' })}
          </div>
          <div className="mt-1 text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {stats.todayEvents}
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 p-3.5 dark:border-neutral-800">
          <div className="text-xxs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {t('dashboard.stats.activeProjects', { defaultValue: 'Active Projects' })}
          </div>
          <div className="mt-1 text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {stats.activeProjectCount}
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 p-3.5 dark:border-neutral-800">
          <div className="text-xxs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {t('dashboard.stats.running', { defaultValue: 'Running Now' })}
          </div>
          <div className="mt-1 text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {stats.runningCount}
          </div>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 text-xxs text-red-500">
          <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Event timeline */}
      <div className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
        <div className="border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h3 className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
            {t('dashboard.eventList.title', { defaultValue: 'Recent Events' })}
          </h3>
        </div>

        {loading && events.length === 0 ? (
          <div className="flex items-center gap-2 px-5 py-8 text-[13px] text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t('dashboard.loading', { defaultValue: 'Loading events…' })}</span>
          </div>
        ) : events.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
            <Activity className="mx-auto mb-2 h-8 w-8 text-neutral-300 dark:text-neutral-600" strokeWidth={1.25} />
            {t('dashboard.empty', { defaultValue: 'No Always-On events recorded yet.' })}
          </div>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
            {events.map((event) => {
              const meta = PHASE_META[event.phase] || PHASE_META.discovery_started;
              const Icon = meta.icon;
              const colorIdx = projectColorMap.get(event.projectName) ?? 0;
              const clickAction = getEventClickAction(event.phase);
              const isClickable = clickAction !== 'none';

              return (
                <div
                  key={event.eventId}
                  role={isClickable ? 'button' : undefined}
                  tabIndex={isClickable ? 0 : undefined}
                  onClick={isClickable ? () => handleEventClick(event) : undefined}
                  onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleEventClick(event); } } : undefined}
                  className={cn(
                    'flex items-start gap-3 px-5 py-3 transition-colors',
                    isErrorPhase(event.phase) && 'bg-red-50/40 dark:bg-red-950/10',
                    isClickable && 'group cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900',
                  )}
                >
                  {/* Phase icon */}
                  <div className={cn('mt-0.5 shrink-0', meta.color)}>
                    <Icon className="h-4 w-4" strokeWidth={1.75} />
                  </div>

                  {/* Main content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {/* Phase label */}
                      <span className={cn('text-[13px] font-medium', meta.color, isClickable && 'group-hover:underline')}>
                        {t(meta.labelKey, { defaultValue: meta.defaultLabel })}
                      </span>

                      {/* Project badge */}
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                          getProjectColor(colorIdx),
                        )}
                        title={event.projectKey}
                      >
                        {event.projectDisplayName}
                      </span>
                    </div>

                    {/* Title / description */}
                    {event.title ? (
                      <p className="mt-0.5 truncate text-[13px] text-neutral-700 dark:text-neutral-300">
                        {event.title}
                      </p>
                    ) : null}

                    {/* Error message */}
                    {event.error ? (
                      <p className="mt-0.5 truncate text-[12px] text-red-500 dark:text-red-400">
                        {event.error.code}: {event.error.message}
                      </p>
                    ) : null}
                  </div>

                  {/* Timestamp */}
                  <div
                    className="shrink-0 self-center font-mono text-xxs text-neutral-400 dark:text-neutral-500"
                    title={formatAbsoluteTime(event.timestamp)}
                  >
                    {formatRelativeTime(event.timestamp)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
