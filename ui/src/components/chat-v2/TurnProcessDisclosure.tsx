import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatedDisclosure } from '../ui/AnimatedDisclosure';
import { turnProcessRegionId, type TurnProcessGroup } from './processGrouping';
import { ProcessRunHeader } from './ProcessTrace';
import { formatProcessDuration } from './processTraceUtils';

export function TurnProcessHeader({ group, scope, expanded, onExpandedChange, waiting = false, showWhileRunning = true }: {
  group: TurnProcessGroup; scope: string; expanded: boolean; onExpandedChange: (expanded: boolean) => void;
  waiting?: boolean; showWhileRunning?: boolean;
}) {
  const { t } = useTranslation('chat');
  const observedStart = useRef(group.isRunning ? Date.now() : undefined);
  const [phase, setPhase] = useState({ running: group.isRunning, stoppedAt: undefined as number | undefined });
  let current = phase;
  if (phase.running !== group.isRunning) {
    current = { running: group.isRunning, stoppedAt: group.isRunning ? undefined : Date.now() };
    if (group.isRunning) observedStart.current = Date.now();
    setPhase(current);
  }
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!group.isRunning || waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [group.isRunning, waiting]);
  const parsedStart = Date.parse(group.startedAt || '');
  const start = Number.isFinite(parsedStart) ? parsedStart : observedStart.current;
  const end = group.isRunning ? now : current.stoppedAt;
  const durationMs = !group.isRunning && group.durationMs !== null ? group.durationMs
    : observedStart.current !== undefined && start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined;
  const duration = formatProcessDuration(durationMs ?? 0, t);
  const label = durationMs === undefined ? t('process.summary.completed', { defaultValue: 'Process completed' })
    : t('process.summary.processed', { duration, defaultValue: `Processed ${duration}` });
  if (waiting || (group.isRunning && !showWhileRunning)) return null;
  return <div data-turn-process-header={group.id}>
    <ProcessRunHeader label={label} expanded={expanded}
      controls={group.memberIds.map(member => turnProcessRegionId(scope, group, member)).join(' ')}
      onExpandedChange={group.memberIds.length ? onExpandedChange : undefined} />
  </div>;
}

export function TurnProcessRegion({ group, scope, member, expanded, output = false, prose = false, children }: {
  group: TurnProcessGroup; scope: string; member: string; expanded: boolean; output?: boolean; prose?: boolean; children: ReactNode;
}) {
  return <AnimatedDisclosure id={turnProcessRegionId(scope, group, member)} expanded={expanded}
    data-turn-process-region={group.id} data-turn-process-member={output ? undefined : 'true'}
    data-turn-process-output={output ? 'true' : undefined} data-turn-process-prose={prose ? 'true' : undefined} contentClassName="pb-2">
    {children}
  </AnimatedDisclosure>;
}
