import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnimatedDisclosure } from '../../ui/AnimatedDisclosure';
import type { ChatMessage } from '../types/types';
import { getProcessGroupIcon } from '../tools/toolIcons';
import { formatCompletedProcessTitle, type RenderableMessageItem } from '../utils/processGrouping';
import { toolCallSummary } from '../tools/toolCallSummary';
import { ProcessLiveStatus } from './ProcessTrace';

export function CompactProcessRow({ message, running }: { message: ChatMessage; running: boolean }) {
  const { t } = useTranslation('chat');
  const active = running && message.compactState === 'running';
  return <ProcessLiveStatus compact step={{ id: message.compactionId || message.id,
    phase: 'compaction',
    title: active ? t('working.compacting', { defaultValue: 'Compacting context...' })
      : formatCompletedProcessTitle([message], t), state: active ? 'running' : 'completed' }} />;
}

/** A stable seat for work between two visible replies, including its closing animation. */
export function ProcessBlock({ trace, expanded, onExpandedChange, children }: {
  trace: NonNullable<RenderableMessageItem['turnTrace']>;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('chat');
  const id = useId();
  const onlyThinking = trace.items.every(item => item.message.isThinking);
  const Icon = getProcessGroupIcon(trace.items.map(item => item.message));
  const measured = trace.items.every(item => typeof item.message.durationMs === 'number');
  const seconds = Math.floor(trace.items.reduce((sum, item) => sum + (item.message.durationMs || 0), 0) / 1000);
  const latest = trace.items.at(-1)?.message;
  const latestTool = latest?.isToolUse ? toolCallSummary(latest, trace.isLive, t) : undefined;
  const title = trace.isLive
    ? latestTool ? `${latestTool.label} ${latestTool.target}`
      : latest?.isThinking ? t('working.thinking', { defaultValue: 'Thinking...' })
      : latest?.isCompactBoundary ? latest.compactState === 'running'
        ? t('working.compacting', { defaultValue: 'Compacting context...' }) : formatCompletedProcessTitle([latest], t)
      : t('process.group.running', { defaultValue: 'Working' })
    : onlyThinking && expanded ? t('process.group.details', { defaultValue: 'Work details' })
    : onlyThinking ? measured ? t('thinking.completedDuration', { count: seconds }) : t('thinking.finished')
    : formatCompletedProcessTitle(trace.items.map(item => item.message), t);
  return <div className="min-w-0" data-process-block={trace.id} data-process-live={trace.isLive}>
    <button type="button" className="chat-process-trigger hover-brand-text" aria-expanded={expanded}
      aria-label={trace.isLive ? t('process.group.details') : undefined}
      aria-description={trace.isLive ? title : undefined}
      aria-controls={id} onClick={() => onExpandedChange(!expanded)}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
      <span className={`min-w-0 truncate ${trace.isLive ? 'chat-process-shimmer' : ''}`} title={title}>{title}</span>
      <ChevronRight aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} strokeWidth={1.8} />
    </button>
    <AnimatedDisclosure id={id} expanded={expanded}>
        <div className="space-y-2 pt-2" data-turn-trace={trace.id}>
          {children}
        </div>
    </AnimatedDisclosure>
  </div>;
}
