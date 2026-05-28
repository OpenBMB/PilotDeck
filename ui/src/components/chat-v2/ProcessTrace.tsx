import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export type ProcessTraceMetric = {
  key: string;
  label: string;
};

export type ProcessTraceStep = {
  id?: string;
  title?: string;
  detail?: string;
  state?: string;
  severity?: string;
  phase?: string;
  toolName?: string;
};

type ProcessTraceProps = {
  label: string;
  collapsedDetail?: string;
  statusLabel?: string;
  status?: string;
  metrics?: ProcessTraceMetric[];
  steps?: ProcessTraceStep[];
  children?: ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  live?: boolean;
  className?: string;
};

export function ProcessRunHeader({
  label,
  className = '',
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-3 border-b border-neutral-200/70 pb-1.5 text-[14px] leading-relaxed text-neutral-500 dark:border-neutral-800/80 dark:text-neutral-400 ${className}`}
    >
      <span className="tabular-nums">{label}</span>
    </div>
  );
}

export function ProcessLiveStatus({
  step,
  children,
  compact = false,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  className = '',
}: {
  step: ProcessTraceStep;
  children?: ReactNode;
  compact?: boolean;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? uncontrolledExpanded;
  const setExpanded = (nextExpanded: boolean | ((value: boolean) => boolean)) => {
    const resolvedExpanded = typeof nextExpanded === 'function'
      ? nextExpanded(expanded)
      : nextExpanded;
    if (controlledExpanded === undefined) {
      setUncontrolledExpanded(resolvedExpanded);
    }
    onExpandedChange?.(resolvedExpanded);
  };
  const { t } = useTranslation('chat');
  const Icon = getStepIcon(step);
  const title = step.title || step.toolName || t('chat:processTrace.working');
  const isRunning = step.state !== 'failed' && step.state !== 'completed' && step.state !== 'cancelled';
  const hasDetails = Boolean(children);
  const statusContent = (
    <>
      <Icon
        className={`mt-[0.28rem] h-3.5 w-3.5 shrink-0 ${getStepIconClass(step)} ${
          Icon === Loader2 && isRunning ? 'animate-spin' : ''
        }`}
        strokeWidth={1.8}
      />
      <div className="min-w-0">
        <div className="truncate">{title}</div>
        {step.detail ? (
          <div className="truncate text-[12px] leading-5 text-neutral-400/80 dark:text-neutral-500/80">
            {step.detail}
          </div>
        ) : null}
      </div>
      {hasDetails ? (
        expanded ? (
          <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
        ) : (
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
        )
      ) : null}
    </>
  );

  return (
    <div
      role="status"
      aria-live="polite"
      className={`process-live-status ${compact ? 'py-0' : 'pb-1'} text-[14px] leading-relaxed text-neutral-400 dark:text-neutral-500 ${className}`}
    >
      {hasDetails ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={`group inline-flex min-w-0 max-w-full items-start gap-2 text-left transition hover:text-neutral-600 dark:hover:text-neutral-300 ${
            isRunning ? 'animate-pulse' : ''
          }`}
        >
          {statusContent}
        </button>
      ) : (
        <div className={`inline-flex min-w-0 max-w-full items-start gap-2 ${isRunning ? 'animate-pulse' : ''}`}>
          {statusContent}
        </div>
      )}
      {expanded && hasDetails ? (
        <div className="mt-1.5 space-y-1.5 pl-5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function getStepIcon(step: ProcessTraceStep): LucideIcon {
  const haystack = `${step.phase || ''} ${step.toolName || ''} ${step.title || ''}`.toLowerCase();

  if (step.state === 'failed' || step.severity === 'error' || step.severity === 'warning') {
    return AlertCircle;
  }
  if (step.phase === 'rag' || /search|grep|glob|find|检索|搜索/.test(haystack)) {
    return Search;
  }
  if (/edit|write|patch|update|create|modify|修改|编辑|写入|创建/.test(haystack)) {
    return Pencil;
  }
  if (/bash|shell|terminal|command|exec|run|命令|运行/.test(haystack)) {
    return Terminal;
  }
  if (step.phase === 'tool' || step.phase === 'subtask' || step.toolName) {
    return Wrench;
  }
  if (step.state === 'completed') {
    return CheckCircle2;
  }
  if (step.state === 'running') {
    return Loader2;
  }
  return Activity;
}

function getStepIconClass(step: ProcessTraceStep): string {
  if (step.state === 'failed' || step.severity === 'error') {
    return 'text-amber-600 dark:text-amber-400';
  }
  if (step.severity === 'warning') {
    return 'text-amber-500 dark:text-amber-400';
  }
  if (step.state === 'running') {
    return 'text-neutral-400 dark:text-neutral-500';
  }
  return 'text-neutral-400 dark:text-neutral-500';
}

function ProcessTraceLine({ step }: { step: ProcessTraceStep }) {
  const { t } = useTranslation('chat');
  const Icon = getStepIcon(step);
  const isRunning = step.state === 'running';
  const title = step.title || step.toolName || t('chat:processTrace.step');

  return (
    <div
      className={`inline-flex min-w-0 max-w-full items-start gap-2 text-[14px] leading-relaxed text-neutral-400 dark:text-neutral-500 ${
        isRunning ? 'animate-pulse' : ''
      }`}
    >
      <Icon
        className={`mt-[0.28rem] h-3.5 w-3.5 shrink-0 ${getStepIconClass(step)} ${
          Icon === Loader2 && isRunning ? 'animate-spin' : ''
        }`}
        strokeWidth={1.9}
      />
      <div className="min-w-0">
        <div className="truncate">{title}</div>
        {step.detail ? (
          <div className="truncate text-[12px] leading-5 text-neutral-400/80 dark:text-neutral-500/80">
            {step.detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ProcessTrace({
  label,
  collapsedDetail,
  statusLabel,
  status = 'completed',
  metrics = [],
  steps = [],
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  live = false,
  className = '',
}: ProcessTraceProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? uncontrolledExpanded;
  const setExpanded = (nextExpanded: boolean | ((value: boolean) => boolean)) => {
    const resolvedExpanded = typeof nextExpanded === 'function'
      ? nextExpanded(expanded)
      : nextExpanded;
    if (controlledExpanded === undefined) {
      setUncontrolledExpanded(resolvedExpanded);
    }
    onExpandedChange?.(resolvedExpanded);
  };
  const hasDetails = Boolean(statusLabel) || metrics.length > 0 || steps.length > 0 || Boolean(children);
  const visibleCollapsedDetail = !expanded && collapsedDetail;
  const statusStep: ProcessTraceStep | null =
    statusLabel || metrics.length > 0
      ? {
          id: 'process-status',
          title: statusLabel,
          detail: metrics.map((metric) => metric.label).join(', '),
          state: status,
        }
      : null;
  const summaryIconStep = steps[0] || statusStep || { title: label, state: status };
  const SummaryIcon = getStepIcon(summaryIconStep);
  const isRunning = status === 'running';

  return (
    <div
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      className={`process-trace py-0 ${className}`}
    >
      <button
        type="button"
        aria-expanded={hasDetails ? expanded : undefined}
        onClick={() => {
          if (hasDetails) {
            setExpanded((value) => !value);
          }
        }}
        disabled={!hasDetails}
        className={`group inline-flex min-w-0 max-w-full items-center gap-2 text-left text-[14px] leading-relaxed text-neutral-400 transition hover:text-neutral-600 disabled:cursor-default disabled:hover:text-neutral-400 dark:text-neutral-500 dark:hover:text-neutral-300 dark:disabled:hover:text-neutral-500 ${
          isRunning ? 'animate-pulse' : ''
        }`}
      >
        <SummaryIcon
          className={`h-3.5 w-3.5 shrink-0 ${getStepIconClass(summaryIconStep)} ${
            SummaryIcon === Loader2 && isRunning ? 'animate-spin' : ''
          }`}
          strokeWidth={1.8}
        />
        <span className="min-w-0 truncate tabular-nums">{label}</span>
        {visibleCollapsedDetail ? (
          <span className="min-w-0 shrink truncate text-neutral-400/75 dark:text-neutral-500/75">
            {visibleCollapsedDetail}
          </span>
        ) : null}
        {hasDetails ? (
          expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400 transition group-hover:text-neutral-500 dark:text-neutral-500 dark:group-hover:text-neutral-300" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400 transition group-hover:text-neutral-500 dark:text-neutral-500 dark:group-hover:text-neutral-300" strokeWidth={1.8} />
          )
        ) : null}
      </button>

      {expanded ? (
        <div className="mt-1.5 space-y-1.5 pl-5">
          {statusStep ? <ProcessTraceLine step={statusStep} /> : null}
          {steps.map((step, index) => (
            <ProcessTraceLine key={step.id || `${step.title || 'process-step'}-${index}`} step={step} />
          ))}
          {children ? <div className="space-y-1.5 pt-0.5">{children}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
