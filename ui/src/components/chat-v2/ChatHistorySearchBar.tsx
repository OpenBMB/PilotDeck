import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
} from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils.js';
import { isImeCompositionEvent } from '../../utils/ime.js';

const IME_ENTER_GRACE_MS = 150;

type ChatHistorySearchBarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  matchCount: number;
  activeMatchIndex: number;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  inputRef: { current: HTMLInputElement | null };
  placement?: 'floating' | 'header';
};

export default function ChatHistorySearchBar({
  query,
  onQueryChange,
  matchCount,
  activeMatchIndex,
  onPrevious,
  onNext,
  onClose,
  inputRef,
  placement = 'floating',
}: ChatHistorySearchBarProps) {
  const { t } = useTranslation();
  const [draftQuery, setDraftQuery] = useState(query);
  const isComposingRef = useRef(false);
  const compositionEndedAtRef = useRef<number | null>(null);
  const hasQuery = query.trim().length > 0;
  const matchLabel = hasQuery
    ? matchCount > 0
      ? t('chatSearch.matchCount', {
          current: activeMatchIndex + 1,
          total: matchCount,
          defaultValue: '{{current}} / {{total}}',
        })
      : t('chatSearch.noMatches', { defaultValue: 'No matches' })
    : '';

  useEffect(() => {
    if (!isComposingRef.current) {
      setDraftQuery(query);
    }
  }, [query]);

  const setInputElement = useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element;
  }, [inputRef]);

  const handleQueryChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.currentTarget.value;
    setDraftQuery(nextValue);
    if (!isComposingRef.current) {
      onQueryChange(nextValue);
    }
  }, [onQueryChange]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    compositionEndedAtRef.current = null;
  }, []);

  const handleCompositionEnd = useCallback((event: CompositionEvent<HTMLInputElement>) => {
    const nextValue = event.currentTarget.value;
    isComposingRef.current = false;
    compositionEndedAtRef.current = Date.now();
    setDraftQuery(nextValue);
    onQueryChange(nextValue);
  }, [onQueryChange]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingRef.current || isImeCompositionEvent(event)) {
      return;
    }

    if (event.key === 'Enter') {
      const compositionEndedAt = compositionEndedAtRef.current;
      const justFinishedComposition = compositionEndedAt !== null
        && Date.now() - compositionEndedAt < IME_ENTER_GRACE_MS;
      if (justFinishedComposition) {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }, [onClose, onNext, onPrevious]);

  return (
    <div
      className={cn(
        'pointer-events-auto flex items-center gap-1 border border-neutral-200 bg-white px-2 dark:border-neutral-700 dark:bg-neutral-900',
        placement === 'header'
          ? 'h-9 w-full max-w-[360px] rounded-md'
          : 'absolute right-4 top-4 z-20 w-[min(100%,320px)] rounded-lg bg-white/95 py-1.5 shadow-lg backdrop-blur-sm dark:bg-neutral-900/95',
      )}
      data-chat-history-search
      role="search"
      aria-label={t('chatSearch.ariaLabel', { defaultValue: 'Search in conversation' }) as string}
    >
      <Search className="h-4 w-4 shrink-0 text-neutral-400" strokeWidth={1.75} aria-hidden />
      <input
        ref={setInputElement}
        type="search"
        value={draftQuery}
        onChange={handleQueryChange}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKeyDown}
        placeholder={t('chatSearch.placeholder', { defaultValue: 'Search in chat…' }) as string}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
        autoComplete="off"
        spellCheck={false}
        aria-label={t('chatSearch.placeholder', { defaultValue: 'Search in chat…' }) as string}
      />
      {hasQuery ? (
        <span className="shrink-0 px-1 text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400">
          {matchLabel}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onPrevious}
        disabled={matchCount === 0}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
        aria-label={t('chatSearch.previous', { defaultValue: 'Previous match' }) as string}
      >
        <ChevronUp className="h-4 w-4" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
        aria-label={t('chatSearch.next', { defaultValue: 'Next match' }) as string}
      >
        <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
      </button>
      {placement === 'floating' ? (
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          aria-label={t('chatSearch.close', { defaultValue: 'Close search' }) as string}
        >
          <X className="h-4 w-4" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}
