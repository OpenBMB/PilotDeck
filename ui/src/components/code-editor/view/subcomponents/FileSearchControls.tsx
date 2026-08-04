import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
} from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { isImeCompositionEvent } from '../../../../utils/ime';

const IME_ENTER_GRACE_MS = 150;

type FileSearchControlsProps = {
  query: string;
  onQueryChange: (query: string) => void;
  matchIndex: number;
  matchCount: number;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onSubmit?: (query: string) => void;
  statusText?: string;
  searchLabel: string;
  placeholder: string;
  previousLabel: string;
  nextLabel: string;
  closeLabel: string;
  noMatchesLabel: string;
  searching?: boolean;
  showNavigation?: boolean;
  className?: string;
};

const controlButtonClass = [
  'flex h-7 w-7 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors',
  'hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-35',
  'dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
].join(' ');

const FileSearchControls = forwardRef<HTMLInputElement, FileSearchControlsProps>(
  function FileSearchControls({
    query,
    onQueryChange,
    matchIndex,
    matchCount,
    onPrevious,
    onNext,
    onClose,
    onSubmit,
    statusText,
    searchLabel,
    placeholder,
    previousLabel,
    nextLabel,
    closeLabel,
    noMatchesLabel,
    searching = false,
    showNavigation = true,
    className = '',
  }, forwardedRef) {
    const [draftQuery, setDraftQuery] = useState(query);
    const composingRef = useRef(false);
    const compositionEndedAtRef = useRef<number | null>(null);

    useEffect(() => {
      if (!composingRef.current) {
        setDraftQuery(query);
      }
    }, [query]);

    const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.currentTarget.value;
      setDraftQuery(nextValue);
      if (!composingRef.current) {
        onQueryChange(nextValue);
      }
    };

    const handleCompositionStart = () => {
      composingRef.current = true;
      compositionEndedAtRef.current = null;
    };

    const handleCompositionEnd = (event: CompositionEvent<HTMLInputElement>) => {
      const nextValue = event.currentTarget.value;
      composingRef.current = false;
      compositionEndedAtRef.current = Date.now();
      setDraftQuery(nextValue);
      onQueryChange(nextValue);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (composingRef.current || isImeCompositionEvent(event)) {
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
        event.stopPropagation();
        if (onSubmit) {
          onSubmit(draftQuery);
        } else if (event.shiftKey) {
          onPrevious();
        } else {
          onNext();
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };

    const resolvedStatus = statusText ?? (
      draftQuery
        ? matchCount > 0
          ? `${matchIndex + 1} / ${matchCount}`
          : noMatchesLabel
        : ''
    );

    return (
      <div
        role="search"
        aria-label={searchLabel}
        className={[
          'flex h-9 w-full min-w-0 items-center rounded-md border border-neutral-200 bg-white px-1.5',
          'dark:border-neutral-700 dark:bg-neutral-900',
          className,
        ].join(' ')}
      >
        <input
          ref={forwardedRef}
          autoFocus
          data-file-search-input
          value={draftQuery}
          onChange={handleChange}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={searchLabel}
          autoComplete="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-[12px] text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
        />
        <span
          aria-live="polite"
          className="ml-1 min-w-12 shrink-0 whitespace-nowrap text-center text-[11px] tabular-nums text-neutral-500"
        >
          {resolvedStatus}
        </span>
        {showNavigation ? (
          <>
            <button
              type="button"
              className={controlButtonClass}
              title={previousLabel}
              aria-label={previousLabel}
              disabled={searching || matchCount === 0}
              onClick={onPrevious}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={controlButtonClass}
              title={nextLabel}
              aria-label={nextLabel}
              disabled={searching || matchCount === 0}
              onClick={onNext}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={controlButtonClass}
          title={closeLabel}
          aria-label={closeLabel}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  },
);

export default FileSearchControls;
