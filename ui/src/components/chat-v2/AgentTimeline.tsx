import { useMemo, useState } from 'react';
import {
  Activity,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  FileSearch,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ProcessTraceStep } from './ProcessTrace';

const PHASE_LABELS: Record<string, string> = {
  rag: 'Searching',
  search: 'Searching',
  read: 'Reading',
  edit: 'Editing',
  write: 'Writing',
  tool: 'Using tool',
  command: 'Running command',
  bash: 'Running command',
  think: 'Thinking',
  plan: 'Planning',
  subtask: 'Sub-task',
  code: 'Coding',
  review: 'Reviewing',
};

const PHASE_ICONS: Record<string, LucideIcon> = {
  rag: Search,
  search: Search,
  read: FileSearch,
  edit: Pencil,
  write: Pencil,
  tool: Wrench,
  command: Terminal,
  bash: Terminal,
  think: BookOpen,
  plan: BookOpen,
  subtask: Activity,
  code: Code2,
  review: FileSearch,
};

export type TimelineGroup = {
  id: string;
  phase: string;
  steps: ProcessTraceStep[];
  isRunning: boolean;
};

function groupStepsByPhase(steps: ProcessTraceStep[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let current: TimelineGroup | null = null;

  for (const step of steps) {
    const phase = step.phase || step.toolName || 'tool';
    const normalizedPhase = normalizePhase(phase);

    if (current && current.phase === normalizedPhase) {
      current.steps.push(step);
      if (step.state === 'running') current.isRunning = true;
    } else {
      current = {
        id: step.id || `group-${groups.length}`,
        phase: normalizedPhase,
        steps: [step],
        isRunning: step.state === 'running',
      };
      groups.push(current);
    }
  }

  return groups;
}

function normalizePhase(raw: string): string {
  const lower = raw.toLowerCase();
  if (/grep|glob|search|websearch|find|rg|检索|搜索/.test(lower)) return 'search';
  if (/read|cat|head|查看|阅读/.test(lower)) return 'read';
  if (/edit|write|patch|update|create|modify|修改|编辑|写入|创建/.test(lower)) return 'edit';
  if (/bash|shell|terminal|command|exec|run|命令|运行/.test(lower)) return 'command';
  if (/think|reason|推理|思考/.test(lower)) return 'think';
  if (/plan|规划|计划/.test(lower)) return 'plan';
  if (/code|实现|编码/.test(lower)) return 'code';
  if (lower in PHASE_LABELS) return lower;
  return 'tool';
}

type AgentTimelineProps = {
  steps: ProcessTraceStep[];
  className?: string;
};

export function AgentTimeline({ steps, className = '' }: AgentTimelineProps) {
  const groups = useMemo(() => groupStepsByPhase(steps), [steps]);

  if (groups.length === 0) return null;

  return (
    <div className={`agent-timeline flex flex-col gap-0.5 ${className}`}>
      {groups.map((group, idx) => (
        <TimelineGroupRow
          key={group.id}
          group={group}
          defaultExpanded={idx === groups.length - 1 && group.isRunning}
        />
      ))}
    </div>
  );
}

function TimelineGroupRow({
  group,
  defaultExpanded,
}: {
  group: TimelineGroup;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const Icon = PHASE_ICONS[group.phase] || Wrench;
  const label = PHASE_LABELS[group.phase] || group.phase;
  const count = group.steps.length;
  const allDone = group.steps.every((s) => s.state === 'completed' || s.state === 'cancelled');

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`hover-brand-text group inline-flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-relaxed transition hover:bg-neutral-100 dark:hover:bg-neutral-800/60 ${
          group.isRunning
            ? 'text-neutral-600 dark:text-neutral-300'
            : 'text-neutral-400 dark:text-neutral-500'
        }`}
      >
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          {group.isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" strokeWidth={2} />
          ) : allDone ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" strokeWidth={2} />
          ) : (
            <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
          )}
        </span>
        <span className="min-w-0 truncate font-medium">{label}</span>
        {count > 1 && (
          <span className="shrink-0 rounded bg-neutral-200/70 px-1.5 text-[11px] font-medium tabular-nums text-neutral-500 dark:bg-neutral-700/50 dark:text-neutral-400">
            {count}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-neutral-400" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-neutral-400" strokeWidth={1.8} />
          )}
        </span>
      </button>

      {expanded && (
        <div className="ml-4 border-l border-neutral-200 pl-3 dark:border-neutral-700/60">
          {group.steps.map((step, idx) => (
            <TimelineStepRow key={step.id || `step-${idx}`} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineStepRow({ step }: { step: ProcessTraceStep }) {
  const isRunning = step.state === 'running';
  const title = step.title || step.toolName || 'Step';

  return (
    <div
      className={`flex items-start gap-2 py-0.5 text-[12px] leading-relaxed ${
        isRunning ? 'text-neutral-600 dark:text-neutral-300' : 'text-neutral-400 dark:text-neutral-500'
      }`}
    >
      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-50" />
      <div className="min-w-0">
        <span className="truncate">{title}</span>
        {step.detail && (
          <span className="ml-1.5 text-neutral-400/70 dark:text-neutral-500/70">{step.detail}</span>
        )}
      </div>
    </div>
  );
}
