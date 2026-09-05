import { useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '../chat/view/subcomponents/Markdown';
import { StreamingScrollViewport } from './StreamingScrollViewport';
import { useTypewriter } from './useTypewriter';

export function ThinkingBlock({ content, isStreaming, inline, projectName, onFileOpen }: {
  content: string;
  isStreaming: boolean;
  inline?: boolean;
  projectName?: string;
  onFileOpen?: (path: string) => void;
}) {
  // Completion updates this same block; it must not close underneath its reader.
  const [expanded, setExpanded] = useState(isStreaming);
  const { t } = useTranslation('chat');
  const text = useTypewriter(content, isStreaming, 4);
  return (
    <div className="min-w-0 text-[14px] leading-relaxed">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={`hover-brand-text flex items-center gap-1.5 text-left text-[13px] font-medium ${inline
          ? 'text-blue-600/70 hover:text-blue-700 dark:text-blue-400/70 dark:hover:text-blue-300'
          : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'}`}
      >
        {isStreaming
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
          : <ChevronRight className={`h-3.5 w-3.5 ${expanded ? 'rotate-90' : ''}`} strokeWidth={2} />}
        <span>{isStreaming
          ? t('working.thinking', { defaultValue: 'Thinking...' })
          : t('thinking.completed', { defaultValue: 'Thought process' })}</span>
      </button>
      {/* Keep the viewport mounted when collapsed so reopening retains its position. */}
      <div hidden={!expanded}>
        <StreamingScrollViewport
          label={t('thinking.liveContentLabel', { defaultValue: 'Live thinking content' })}
          enabled={expanded && (isStreaming || text !== content)}
          className={`mt-1.5 border-l-2 pl-3 text-[13px] text-neutral-600 dark:text-neutral-300 ${inline
            ? 'border-blue-400/50 dark:border-blue-500/40'
            : 'border-neutral-200 dark:border-neutral-700'}`}
        >
          <Markdown projectName={projectName} onFileOpen={onFileOpen} isStreaming={isStreaming || text !== content}>{text}</Markdown>
        </StreamingScrollViewport>
      </div>
    </div>
  );
}
