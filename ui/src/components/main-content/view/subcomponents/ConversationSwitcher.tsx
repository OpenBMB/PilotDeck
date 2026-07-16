import {
  Check,
  ChevronDown,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Search,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils.js';
import { sessionDisplayTitle, useCustomNamesVersion } from '../../../../lib/customNames';
import type { Project, ProjectSession } from '../../../../types/app';

type ConversationSwitcherProps = {
  project: Project;
  selectedSession: ProjectSession | null;
  processingSessions: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (session: ProjectSession) => void;
  onNewSession: () => void;
};

const asTimestamp = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sessionTimestamp = (session: ProjectSession): number => Math.max(
  asTimestamp(session.lastActivity),
  asTimestamp(session.updated_at),
  asTimestamp(session.createdAt),
  asTimestamp(session.created_at),
);

const formatRelativeTime = (timestamp: number, locale: string): string => {
  if (!timestamp) return '';
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (elapsedSeconds < 60) return formatter.format(-elapsedSeconds, 'second');
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return formatter.format(-elapsedMinutes, 'minute');
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return formatter.format(-elapsedHours, 'hour');
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return formatter.format(-elapsedDays, 'day');
  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return formatter.format(-elapsedMonths, 'month');
  return formatter.format(-Math.floor(elapsedMonths / 12), 'year');
};

export default function ConversationSwitcher({
  project,
  selectedSession,
  processingSessions,
  unreadSessionIds,
  onSelectSession,
  onNewSession,
}: ConversationSwitcherProps) {
  const { t, i18n } = useTranslation();
  useCustomNamesVersion();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sessionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const projectSessions = Array.isArray(project.sessions) ? project.sessions : [];
  const mergedSessions = selectedSession
    && !projectSessions.some((session) => session.id === selectedSession.id)
    ? [selectedSession, ...projectSessions]
    : projectSessions;
  const sessions = [...mergedSessions]
    .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left));
  const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language);
  const filteredSessions = normalizedQuery
    ? sessions.filter((session) =>
      sessionDisplayTitle(session).toLocaleLowerCase(i18n.language).includes(normalizedQuery),
    )
    : sessions;

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [close, open]);

  const focusSession = useCallback((index: number) => {
    if (filteredSessions.length === 0) return;
    const nextIndex = (index + filteredSessions.length) % filteredSessions.length;
    sessionButtonRefs.current[nextIndex]?.focus();
  }, [filteredSessions.length]);

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusSession(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusSession(filteredSessions.length - 1);
    }
  };

  const handleSessionKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusSession(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index === 0) searchRef.current?.focus();
      else focusSession(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusSession(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusSession(filteredSessions.length - 1);
    }
  };

  const currentTitle = selectedSession
    ? sessionDisplayTitle(selectedSession)
    : t('filesWorkbench.conversations.newConversation');

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-1 items-center gap-1">
      <button
        ref={triggerRef}
        type="button"
        data-testid="files-conversation-switcher-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('filesWorkbench.conversations.switchConversation')}
        title={currentTitle}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="group flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left transition hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 dark:hover:bg-neutral-800 dark:focus-visible:ring-neutral-700"
      >
        <MessageSquare className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.8} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-medium leading-4 text-neutral-700 dark:text-neutral-300">
              {t('filesWorkbench.assistant')}
            </span>
            <span className="block truncate text-[10px] leading-3 text-neutral-400 dark:text-neutral-500">
              {currentTitle}
            </span>
          </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform group-hover:text-neutral-600 dark:text-neutral-500 dark:group-hover:text-neutral-300',
            open && 'rotate-180',
          )}
          strokeWidth={1.8}
        />
      </button>

      <button
        type="button"
        onClick={() => {
          close();
          onNewSession();
        }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 dark:focus-visible:ring-neutral-700"
        title={t('filesWorkbench.conversations.newConversation')}
        aria-label={t('filesWorkbench.conversations.newConversation')}
      >
        <MessageSquarePlus className="h-4 w-4" strokeWidth={1.8} />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t('filesWorkbench.conversations.switchConversation')}
          data-testid="files-conversation-switcher-popover"
          className="absolute left-0 top-[calc(100%+0.4rem)] z-[70] flex max-h-[min(30rem,calc(100vh-7rem))] w-[calc(100%+2.25rem)] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div className="border-b border-neutral-100 p-2 dark:border-neutral-800">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" strokeWidth={1.8} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('filesWorkbench.conversations.searchPlaceholder')}
                aria-label={t('filesWorkbench.conversations.searchPlaceholder')}
                className="h-8 w-full rounded-lg border border-neutral-200 bg-neutral-50 pl-8 pr-2 text-[12px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-neutral-400 focus:bg-white dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500 dark:focus:bg-neutral-900"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                close();
                onNewSession();
              }}
              className="mt-2 flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] font-medium text-neutral-700 transition hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus-visible:ring-neutral-700"
            >
              <MessageSquarePlus className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" strokeWidth={1.8} />
              {t('filesWorkbench.conversations.newConversation')}
            </button>
          </div>

          <div className="min-h-0 overflow-y-auto p-1.5" role="listbox" aria-label={t('filesWorkbench.conversations.recentConversations')}>
            <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              {t('filesWorkbench.conversations.recentConversations')}
            </div>
            {filteredSessions.length > 0 ? filteredSessions.map((session, index) => {
              const isSelected = selectedSession?.id === session.id;
              const isProcessing = processingSessions.has(session.id) || session.id.startsWith('new-session-');
              const isUnread = unreadSessionIds.has(session.id);
              const title = sessionDisplayTitle(session);
              const relativeTime = formatRelativeTime(sessionTimestamp(session), i18n.language);
              return (
                <button
                  key={session.id}
                  ref={(node) => {
                    sessionButtonRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={session.id.startsWith('new-session-')}
                  onClick={() => {
                    close();
                    onSelectSession(session);
                  }}
                  onKeyDown={(event) => handleSessionKeyDown(event, index)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 dark:focus-visible:ring-neutral-700',
                    isSelected
                      ? 'bg-neutral-100 dark:bg-neutral-800'
                      : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/70',
                    session.id.startsWith('new-session-') && 'cursor-default opacity-70',
                  )}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    {isProcessing ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin text-neutral-500 dark:text-neutral-400"
                        strokeWidth={1.8}
                        aria-label={t('filesWorkbench.conversations.running')}
                      />
                    ) : isUnread ? (
                      <span
                        role="status"
                        className="h-2 w-2 rounded-full bg-blue-500"
                        aria-label={t('filesWorkbench.conversations.unread')}
                      />
                    ) : (
                      <MessageSquare className="h-3.5 w-3.5 text-neutral-400 dark:text-neutral-500" strokeWidth={1.7} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-neutral-700 dark:text-neutral-200" title={title}>
                      {title}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-neutral-400 dark:text-neutral-500">
                      {isProcessing
                        ? t('filesWorkbench.conversations.running')
                        : isUnread
                          ? t('filesWorkbench.conversations.unread')
                          : relativeTime}
                    </span>
                  </span>
                  {isSelected ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-neutral-600 dark:text-neutral-300" strokeWidth={2} />
                  ) : null}
                </button>
              );
            }) : (
              <div className="px-3 py-8 text-center text-[12px] text-neutral-400 dark:text-neutral-500">
                {t('filesWorkbench.conversations.noResults')}
              </div>
            )}
          </div>

          {project.sessionMeta?.hasMore ? (
            <div className="border-t border-neutral-100 px-3 py-2 text-[10px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
              {t('filesWorkbench.conversations.recentOnly')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
