import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TextContentReference } from '../../types/contentReference';
import { cn } from '../../lib/utils.js';

const COMPOSER_CHIP_CLASS = [
  'pd-composer-selection-chip group/chip inline-flex min-h-7 max-w-full items-center gap-0 rounded-lg border border-[#d7d2fb] bg-[#f0edff] px-2.5 text-[12px] font-[650] leading-none text-[#544dbd] transition-colors duration-[120ms]',
  'hover:border-[#bdb5f2] hover:bg-[#e9e5ff] hover:text-[#433ba8]',
  'dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-200',
].join(' ');

const CHIP_REMOVE_CLASS = [
  'pointer-events-none ml-0 grid h-[18px] w-0 flex-[0_0_0] place-items-center overflow-hidden border-0 bg-transparent p-0 text-[18px] font-normal leading-none text-current opacity-0 outline-none',
  'transition-[width,flex-basis,margin-left,opacity] duration-[140ms]',
  'group-focus-within/chip:pointer-events-auto group-focus-within/chip:ml-1 group-focus-within/chip:w-[18px] group-focus-within/chip:flex-[0_0_18px] group-focus-within/chip:opacity-100',
  'group-hover/chip:pointer-events-auto group-hover/chip:ml-1 group-hover/chip:w-[18px] group-hover/chip:flex-[0_0_18px] group-hover/chip:opacity-100',
].join(' ');

type ReplyQuoteChipProps = {
  quotes: TextContentReference[];
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
};

export default function ReplyQuoteChip({
  quotes,
  onRemove,
  onRemoveAll,
}: ReplyQuoteChipProps) {
  const { t } = useTranslation('chat');
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openPanel = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 140);
  };

  useEffect(() => () => clearCloseTimer(), []);

  useEffect(() => {
    if (!open || !chipRef.current) return;
    const updatePosition = () => {
      if (!chipRef.current) return;
      const rect = chipRef.current.getBoundingClientRect();
      const width = Math.min(360, Math.max(240, window.innerWidth - 16));
      const left = Math.min(
        window.innerWidth - width - 8,
        Math.max(8, rect.left),
      );
      setPanelStyle({
        position: 'fixed',
        left,
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
        width,
        zIndex: 80,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, quotes.length]);

  if (quotes.length === 0) return null;

  const label = t('replyQuotes.chip', {
    count: quotes.length,
    defaultValue: `${quotes.length}条标签`,
  });

  return (
    <>
      <span
        ref={chipRef}
        className={COMPOSER_CHIP_CLASS}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        onMouseEnter={openPanel}
        onMouseLeave={scheduleClose}
        onFocus={openPanel}
        onBlur={(event) => {
          if (panelRef.current?.contains(event.relatedTarget as Node)) return;
          scheduleClose();
        }}
      >
        <span className="min-w-0 truncate">{label}</span>
        {onRemoveAll ? (
          <button
            type="button"
            className={CHIP_REMOVE_CLASS}
            aria-label={t('replyQuotes.removeAll', { defaultValue: '删除全部标签' })}
            title={t('common.remove', { defaultValue: '删除' }) as string}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRemoveAll();
            }}
          >
            ×
          </button>
        ) : null}
      </span>
      {open && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="list"
            aria-label={t('replyQuotes.panelLabel', { defaultValue: '已引用的回复内容' }) as string}
            className={cn(
              'rounded-xl border border-neutral-200 bg-white p-1.5 shadow-lg',
              'dark:border-neutral-700 dark:bg-neutral-900',
            )}
            style={panelStyle}
            onMouseEnter={openPanel}
            onMouseLeave={scheduleClose}
          >
            <div className="max-h-64 overflow-y-auto">
              {quotes.map((quote, index) => (
                <div
                  key={quote.id}
                  role="listitem"
                  className="flex items-start gap-1 rounded-lg px-2 py-1.5 text-[12px] text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800"
                >
                  <span className="mt-0.5 w-4 shrink-0 text-[11px] tabular-nums text-neutral-400">
                    {index + 1}.
                  </span>
                  <span
                    className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-5"
                    title={quote.selectedText}
                  >
                    {quote.selectedText}
                  </span>
                  {onRemove ? (
                    <button
                      type="button"
                      className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded text-[16px] leading-none text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                      aria-label={t('replyQuotes.remove', { defaultValue: '删除这条标签' })}
                      title={t('common.remove', { defaultValue: '删除' }) as string}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onRemove(quote.id);
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )
        : null}
    </>
  );
}
