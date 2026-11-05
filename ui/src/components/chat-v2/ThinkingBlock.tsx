import { useEffect, useId, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnimatedDisclosure } from '../ui/AnimatedDisclosure';
import { Markdown } from '../chat/view/subcomponents/Markdown';
import { StreamingScrollViewport } from './StreamingScrollViewport';

export function ThinkingBlock({ content, isStreaming, startedAt, durationMs, inline, projectName, onFileOpen }: {
  content: string;
  isStreaming: boolean;
  startedAt?: string;
  durationMs?: number | null;
  inline?: boolean;
  projectName?: string;
  onFileOpen?: (path: string) => void;
}) {
  // Phase defaults follow streaming; deliberate openings remain pinned.
  const [view, setView] = useState(() => ({ streaming: isStreaming, expanded: isStreaming,
    pinnedOpen: false, observedStart: isStreaming ? Date.now() : undefined, stoppedAt: undefined as number | undefined }));
  let phase = view;
  if (view.streaming !== isStreaming) {
    phase = { streaming: isStreaming, expanded: view.pinnedOpen || isStreaming, pinnedOpen: view.pinnedOpen,
      observedStart: isStreaming ? Date.now() : view.observedStart,
      stoppedAt: isStreaming ? undefined : Date.now() };
    setView(phase);
  }
  const { expanded } = phase;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!isStreaming) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming]);
  const parsedStart = Date.parse(startedAt || '');
  const start = Number.isFinite(parsedStart) ? parsedStart : phase.observedStart;
  const end = isStreaming ? now : phase.stoppedAt;
  const elapsed = !isStreaming && typeof durationMs === 'number' && Number.isFinite(durationMs)
    ? Math.max(0, durationMs)
    : start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined;
  const seconds = elapsed === undefined ? undefined : Math.floor(elapsed / 1000);
  const contentId = useId();
  const { t } = useTranslation('chat');
  const label = seconds === undefined
    ? t('thinking.finished', { defaultValue: 'Finished thinking' })
    : t(isStreaming ? 'thinking.runningDuration' : 'thinking.completedDuration', {
      count: seconds, defaultValue: isStreaming ? `Thinking for ${seconds}s` : `Thought for ${seconds}s`,
    });
  return (
    <div className="min-w-0" data-thinking-state={isStreaming ? 'running' : 'completed'}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setView({ ...phase, expanded: !expanded, pinnedOpen: !expanded })}
        className="chat-process-trigger hover-brand-text"
      >
        <Brain aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${isStreaming ? 'motion-safe:animate-pulse' : ''}`} strokeWidth={1.8} />
        <span className="min-w-0 truncate tabular-nums">{label}</span>
        <ChevronRight aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} strokeWidth={1.8} />
      </button>
      {/* Keep the viewport mounted when collapsed so reopening retains its position. */}
      <AnimatedDisclosure id={contentId} expanded={expanded} keepMounted>
          <StreamingScrollViewport
            label={t('thinking.liveContentLabel', { defaultValue: 'Live thinking content' })}
            enabled={expanded && isStreaming}
            className={`ml-[22px] mt-2 border-l-2 pl-3 text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-300 ${inline
              ? 'border-[var(--brand)]'
              : 'border-neutral-200 dark:border-neutral-700'}`}
          >
            <Markdown projectName={projectName} onFileOpen={onFileOpen} isStreaming={isStreaming}>{content}</Markdown>
          </StreamingScrollViewport>
      </AnimatedDisclosure>
    </div>
  );
}
