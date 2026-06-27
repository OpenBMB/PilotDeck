import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2 } from 'lucide-react';
import type { ChatMessage } from '../chat/types/types';
import type { Project, SessionProvider } from '../../types/app';
import SubagentDetailMessageFlow from './SubagentDetailMessageFlow';

type DiffLine = { type: string; content: string; lineNum: number };

interface SubagentDetailModalProps {
  subagentId: string;
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  provider: SessionProvider;
  selectedProject: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  showThinking?: boolean;
  isRunning?: boolean;
  onClose: () => void;
}

export default function SubagentDetailModal({
  subagentId,
  messages,
  isLoading,
  error,
  provider,
  selectedProject,
  createDiff,
  onFileOpen,
  showThinking = true,
  isRunning = false,
  onClose,
}: SubagentDetailModalProps) {
  const { t } = useTranslation('chat');
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeLabel = t('subagent.closeDetail', {
    defaultValue: 'Close subagent detail',
  }) as string;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  let content: ReactNode;
  if (isLoading) {
    content = (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
      </div>
    );
  } else if (error) {
    content = (
      <div className="px-6 py-12 text-center text-sm text-red-500">
        {t('subagent.loadError', { error })}
      </div>
    );
  } else if (messages.length === 0) {
    content = (
      <div className="px-6 py-12 text-center text-sm text-neutral-500 dark:text-neutral-400">
        {t('subagent.noMessages')}
      </div>
    );
  } else {
    content = (
      <SubagentDetailMessageFlow
        messages={messages}
        provider={provider}
        selectedProject={selectedProject}
        createDiff={createDiff}
        onFileOpen={onFileOpen}
        showThinking={showThinking}
        isRunning={isRunning}
      />
    );
  }

  return (
    <div
      ref={overlayRef}
      data-modal-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-6 py-3 dark:border-neutral-700">
          <h2 id={titleId} className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            {t('subagent.detailTitle')}
            <span aria-hidden="true" className="ml-2 font-mono text-xs text-neutral-400 dark:text-neutral-500">
              {subagentId.slice(0, 8)}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            aria-label={closeLabel}
            title={closeLabel}
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {content}
        </div>
      </div>
    </div>
  );
}
