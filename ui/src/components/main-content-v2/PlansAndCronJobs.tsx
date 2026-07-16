import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Archive,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type {
  DiscoveryPlanOverview,
  DiscoveryPlanStatus,
  Project,
  ProjectDiscoveryPlansResponse,
  WorkCycleOverview,
} from '../../types/app';
import { api } from '../../utils/api';
import { cn } from '../../lib/utils.js';

const POLL_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

type PlanDisplayStatus =
  | 'created'
  | 'preparingWorkspace'
  | 'executing'
  | 'completedWaiting'
  | 'completedNoReport'
  | 'failed'
  | 'archived';

function mapPlanStatus(status: DiscoveryPlanStatus): PlanDisplayStatus {
  switch (status) {
    case 'ready':
      return 'created';
    case 'queued':
      return 'preparingWorkspace';
    case 'running':
      return 'executing';
    case 'completed':
      return 'completedWaiting';
    case 'completed_no_report':
      return 'completedNoReport';
    case 'failed':
      return 'failed';
    case 'archived':
      return 'archived';
    default:
      return 'created';
  }
}

const PLAN_STATUS_STYLE: Record<PlanDisplayStatus, string> = {
  created: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  preparingWorkspace: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  executing: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  completedWaiting: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  completedNoReport: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  archived: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
};

const PLAN_STATUS_LABEL: Record<PlanDisplayStatus, { key: string; defaultValue: string }> = {
  created: { key: 'plansCron.status.created', defaultValue: 'Created' },
  preparingWorkspace: { key: 'plansCron.status.preparingWorkspace', defaultValue: 'Preparing Workspace' },
  executing: { key: 'plansCron.status.executing', defaultValue: 'Executing' },
  completedWaiting: { key: 'plansCron.status.completedWaiting', defaultValue: 'Completed' },
  completedNoReport: { key: 'plansCron.status.completedNoReport', defaultValue: 'Report Unavailable' },
  failed: { key: 'plansCron.status.failed', defaultValue: 'Failed' },
  archived: { key: 'plansCron.status.archived', defaultValue: 'Archived' },
};

// ---------------------------------------------------------------------------
// Plan row type
// ---------------------------------------------------------------------------

type PlanItem = {
  data: DiscoveryPlanOverview;
  projectName: string;
  projectDisplayName: string;
  projectKey: string;
};

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Column widths (shared between header and body for alignment)
// ---------------------------------------------------------------------------

const COL = {
  title: 'min-w-0 flex-1 max-w-[380px]',
  createdAt: 'w-[150px] shrink-0',
  status: 'w-[160px] shrink-0',
  actions: 'w-[140px] shrink-0',
} as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type PlansAndCronJobsProps = {
  onApplyWorkCycle?: (projectName: string, cycleId: string) => Promise<void>;
  onOpenPlanDetail?: (planId: string, projectName: string, projectDisplayName: string, sourceRunId: string, projectKey: string) => void;
  compact?: boolean;
};

export default function PlansAndCronJobs({ onApplyWorkCycle, onOpenPlanDetail, compact = false }: PlansAndCronJobsProps) {
  const { t } = useTranslation('alwaysOn');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [plansByProject, setPlansByProject] = useState<Map<string, DiscoveryPlanOverview[]>>(new Map());
  const [cyclesByProject, setCyclesByProject] = useState<Map<string, WorkCycleOverview[]>>(new Map());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [cycleBusy, setCycleBusy] = useState<string | null>(null);
  const [confirmingArchiveCycle, setConfirmingArchiveCycle] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const projectsRes = await api.projects();
      if (!projectsRes.ok) throw new Error(`Projects: HTTP ${projectsRes.status}`);
      const projectsList: Project[] = await projectsRes.json();
      setProjects(projectsList);

      const mixedResults = await Promise.all(
        projectsList.flatMap((p) => [
          api.projectDiscoveryPlans(p.name),
          api.projectWorkCycles(p.name),
        ]),
      );

      const newPlansByProject = new Map<string, DiscoveryPlanOverview[]>();
      const newCyclesByProject = new Map<string, WorkCycleOverview[]>();
      for (let i = 0; i < projectsList.length; i++) {
        const planRes = mixedResults[i * 2];
        const cycleRes = mixedResults[i * 2 + 1];
        if (planRes && planRes.ok) {
          const payload = (await planRes.json()) as ProjectDiscoveryPlansResponse;
          if (Array.isArray(payload.plans) && payload.plans.length > 0) {
            newPlansByProject.set(projectsList[i]!.name, payload.plans);
          }
        }
        if (cycleRes && cycleRes.ok) {
          const payload = (await cycleRes.json()) as { cycles?: WorkCycleOverview[] };
          if (Array.isArray(payload.cycles) && payload.cycles.length > 0) {
            newCyclesByProject.set(projectsList[i]!.name, payload.cycles);
          }
        }
      }
      setPlansByProject(newPlansByProject);
      setCyclesByProject(newCyclesByProject);
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
    for (const p of projects) projectMap.set(p.name, p);

    const result = new Map<string, { displayName: string; items: PlanItem[] }>();

    for (const [projectName, plans] of plansByProject) {
      const project = projectMap.get(projectName);
      const displayName = project?.displayName || projectName;
      if (!result.has(projectName)) {
        result.set(projectName, { displayName, items: [] });
      }
      for (const plan of plans) {
        result.get(projectName)!.items.push({
          data: plan,
          projectName,
          projectDisplayName: displayName,
          projectKey: project?.fullPath || '',
        });
      }
    }

    for (const group of result.values()) {
      group.items.sort((a, b) => {
        const timeA = Date.parse(a.data.createdAt) || 0;
        const timeB = Date.parse(b.data.createdAt) || 0;
        return timeB - timeA;
      });
    }

    return result;
  }, [projects, plansByProject]);

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
    <div className={cn('w-full space-y-5 py-5', compact ? 'px-4' : 'px-8')}>
      {/* Header */}
      <div className={cn('flex items-start justify-between gap-3', compact && 'flex-col')}>
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            {t('plansCron.title', { defaultValue: 'Plans' })}
          </h2>
          <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
            {t('plansCron.subtitle', { defaultValue: 'Always-On plans across projects.' })}
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

      {error ? (
        <div className="flex items-center gap-2 text-xxs text-red-500">
          <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{error}</span>
        </div>
      ) : null}

      {loading && totalItems === 0 ? (
        <div className="flex items-center gap-2 py-8 text-[13px] text-neutral-500 dark:text-neutral-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          <span>{t('plansCron.loading', { defaultValue: 'Loading plans…' })}</span>
        </div>
      ) : totalItems === 0 && !loading ? (
        <div className="py-8 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
          <FileText className="mx-auto mb-2 h-8 w-8 text-neutral-300 dark:text-neutral-600" strokeWidth={1.25} />
          {t('plansCron.empty', { defaultValue: 'No plans found.' })}
        </div>
      ) : (
        <div className="space-y-4">
          {[...grouped.entries()].map(([projectKey, { displayName, items }]) => {
            const isCollapsed = collapsedProjects.has(projectKey);
            const label = displayName;

            return (
              <div
                key={projectKey}
                className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
              >
                {/* Project group header */}
                <button
                  type="button"
                  onClick={() => toggleProject(projectKey)}
                  className="flex w-full items-center gap-2 px-5 py-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} />
                  )}
                  <span className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
                    {label}
                  </span>
                  <span className="ml-auto text-xxs tabular-nums text-neutral-400 dark:text-neutral-500">
                    {items.length}
                  </span>
                </button>

                {!isCollapsed && (() => {
                  const cycles = cyclesByProject.get(projectKey) ?? [];
                  const activeCycle = cycles.find((c) => c.status === 'active' || c.status === 'applying');
                  const hasCompletedPlan = items.some((p) => {
                    const s = (p.data as DiscoveryPlanOverview).status;
                    return s === 'completed' || s === 'completed_no_report';
                  });
                  const canApply = !!activeCycle && activeCycle.status === 'active' && hasCompletedPlan;
                  const canArchive = !!activeCycle && activeCycle.status === 'active';
                  const isApplying = activeCycle?.status === 'applying';
                  const busy = !!activeCycle && cycleBusy === activeCycle.id;

                  const handleApply = async () => {
                    if (!activeCycle || busy) return;
                    setCycleBusy(activeCycle.id);
                    try {
                      if (onApplyWorkCycle) {
                        await onApplyWorkCycle(projectKey, activeCycle.id);
                      } else {
                        const res = await api.applyWorkCycle(projectKey, activeCycle.id);
                        if (!res.ok) {
                          const body = await res.json().catch(() => ({})) as { error?: string };
                          throw new Error(body?.error || `HTTP ${res.status}`);
                        }
                      }
                      await refresh();
                    } catch {
                      // Visible via refresh.
                    } finally {
                      setCycleBusy(null);
                    }
                  };

                  const handleArchive = async () => {
                    if (!activeCycle || busy) return;
                    setCycleBusy(activeCycle.id);
                    try {
                      const res = await api.archiveWorkCycle(projectKey, activeCycle.id);
                      if (!res.ok) {
                        const body = await res.json().catch(() => ({})) as { error?: string };
                        throw new Error(body?.error || `HTTP ${res.status}`);
                      }
                      await refresh();
                    } catch {
                      // Visible via refresh.
                    } finally {
                      setCycleBusy(null);
                      setConfirmingArchiveCycle(null);
                    }
                  };

                  const confirmingArchive = !!activeCycle && confirmingArchiveCycle === activeCycle.id;

                  return (
                    <>
                      {items.length > 0 && (
                        <SubSection
                          sectionKey={`${projectKey}::plans`}
                          label={`${t('plansCron.type.plan', { defaultValue: 'Plan' })} (${items.length})`}
                          collapsedSections={collapsedSections}
                          toggleSection={toggleSection}
                          actions={
                            <div className="flex items-center gap-1.5">
                              {isApplying && (
                                <span className="inline-flex items-center gap-1 text-xxs text-sky-600 dark:text-sky-400">
                                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                                  {t('plansCron.cycleStatus.applying', { defaultValue: 'Applying…' })}
                                </span>
                              )}
                              {canApply && !isApplying && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleApply()}
                                  className="inline-flex h-7 items-center rounded-md bg-emerald-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-700 dark:hover:bg-emerald-600"
                                >
                                  {busy ? (
                                    <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                                  ) : (
                                    t('plansCron.actions.applyCycle', { defaultValue: 'Apply All' })
                                  )}
                                </button>
                              )}
                              {canArchive && !confirmingArchive && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setConfirmingArchiveCycle(activeCycle!.id)}
                                  className="inline-flex h-7 items-center rounded-md border border-neutral-200 px-2 text-neutral-500 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-red-700 dark:hover:text-red-400"
                                  title={t('plansCron.actions.archiveCycle', { defaultValue: 'Archive' })}
                                >
                                  <Archive className="h-3.5 w-3.5" strokeWidth={1.75} />
                                </button>
                              )}
                              {confirmingArchive && (
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleArchive()}
                                    className="inline-flex h-7 items-center rounded-md bg-red-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                                  >
                                    {busy ? (
                                      <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                                    ) : (
                                      t('plansCron.actions.archiveCycle', { defaultValue: 'Archive' })
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmingArchiveCycle(null)}
                                    className="inline-flex h-7 items-center rounded-md border border-neutral-200 px-2 text-[11px] text-neutral-500 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
                                  >
                                    ✕
                                  </button>
                                </div>
                              )}
                            </div>
                          }
                        >
                          {!compact ? <ColumnHeaders t={t} /> : null}
                          <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
                            {items.map((item) => (
                              <ItemRow
                                key={`plan-${item.data.id}`}
                                item={item}
                                t={t}
                                onRefresh={refresh}
                                onOpenPlanDetail={onOpenPlanDetail}
                                compact={compact}
                              />
                            ))}
                          </div>
                        </SubSection>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible sub-section within a project card
// ---------------------------------------------------------------------------

function SubSection({
  sectionKey,
  label,
  collapsedSections,
  toggleSection,
  actions,
  children,
}: {
  sectionKey: string;
  label: string;
  collapsedSections: Set<string>;
  toggleSection: (key: string) => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isCollapsed = collapsedSections.has(sectionKey);
  return (
    <>
      <div className="flex items-center gap-2 border-t border-neutral-200 bg-neutral-50/80 px-5 py-2 dark:border-neutral-800 dark:bg-neutral-900/30">
        <button
          type="button"
          onClick={() => toggleSection(sectionKey)}
          className="flex items-center gap-1.5 text-xxs font-semibold uppercase tracking-wider text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          {isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          )}
          {label}
        </button>
        {!isCollapsed && actions && <div className="ml-auto">{actions}</div>}
      </div>
      {!isCollapsed && children}
    </>
  );
}

// ---------------------------------------------------------------------------
// Column headers
// ---------------------------------------------------------------------------

function ColumnHeaders({ t }: { t: (key: string, opts?: Record<string, string>) => string }) {
  return (
    <div className="flex items-center gap-4 border-b border-neutral-200 bg-neutral-50 px-5 py-2 dark:border-neutral-800 dark:bg-neutral-900/50">
      <div className={COL.title}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('plansCron.columns.title', { defaultValue: 'Title' })}
        </span>
      </div>
      <div className={COL.createdAt}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('plansCron.columns.createdAt', { defaultValue: 'Created' })}
        </span>
      </div>
      <div className={COL.status}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('plansCron.columns.status', { defaultValue: 'Status' })}
        </span>
      </div>
      <div className={COL.actions}>
        <span className="text-xxs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('plansCron.columns.actions', { defaultValue: 'Actions' })}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  t,
  onRefresh,
  onOpenPlanDetail,
  compact = false,
}: {
  item: PlanItem;
  t: (key: string, opts?: Record<string, string>) => string;
  onRefresh: () => Promise<void>;
  onOpenPlanDetail?: (planId: string, projectName: string, projectDisplayName: string, sourceRunId: string, projectKey: string) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const plan = item.data;
  const title = plan.title || '—';
  const fullTitle = plan.title || '';
  const createdAt = plan.createdAt;
  const displayStatus = mapPlanStatus(plan.status);
  const meta = PLAN_STATUS_LABEL[displayStatus];
  const statusLabel = t(meta.key, { defaultValue: meta.defaultValue });
  const statusStyle = PLAN_STATUS_STYLE[displayStatus];

  const showRetry = displayStatus === 'failed';

  const handleRetry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.executeProjectDiscoveryPlan(item.projectName, plan.id, { source: 'manual' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      await onRefresh();
    } catch {
      // Visible via refresh.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn(
      'transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/40',
      compact
        ? 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-4 py-3'
        : 'flex items-center gap-4 px-5 py-2.5',
    )}>
      {/* Title */}
      <div className={cn(
        compact ? 'col-span-2 min-w-0' : COL.title,
        'truncate text-[13px] text-neutral-900 dark:text-neutral-100',
      )} title={fullTitle}>
        {onOpenPlanDetail ? (
          <button
            type="button"
            onClick={() => onOpenPlanDetail(plan.id, item.projectName, item.projectDisplayName, plan.sourceRunId || plan.sourceDiscoverySessionId || '', item.projectKey)}
            className="truncate text-left hover:underline"
          >
            {title}
          </button>
        ) : (
          title
        )}
      </div>

      {/* Created */}
      <div className={cn(
        compact ? 'w-auto' : COL.createdAt,
        'font-mono text-xxs tabular-nums text-neutral-500 dark:text-neutral-400',
      )}>
        {formatAbsoluteTime(createdAt)}
      </div>

      {/* Status */}
      <div className={compact ? 'w-auto justify-self-end' : COL.status}>
        <span className={cn('inline-block rounded-full px-2 py-0.5 text-[11px] font-medium', statusStyle)}>
          {statusLabel}
        </span>
      </div>

      {/* Actions */}
      <div className={cn(
        compact ? 'col-span-2 flex w-full justify-end' : COL.actions,
        'items-center gap-1.5',
        !compact && 'flex',
      )}>
        {showRetry && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRetry()}
            className="inline-flex h-7 items-center rounded-md bg-blue-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
            ) : (
              t('plansCron.actions.retry', { defaultValue: 'Retry' })
            )}
          </button>
        )}
      </div>
    </div>
  );
}
