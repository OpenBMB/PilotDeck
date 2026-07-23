import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export type SpreadsheetSheetTab = {
  index: number;
  name: string;
};

type SpreadsheetTabsProps = {
  sheets: SpreadsheetSheetTab[];
  activeSheetIndex: number;
  disabled?: boolean;
  onSelect: (sheetIndex: number) => void;
};

export default function SpreadsheetTabs({
  sheets,
  activeSheetIndex,
  disabled = false,
  onSelect,
}: SpreadsheetTabsProps) {
  const { t } = useTranslation('codeEditor');
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeSheetIndex]);

  const scrollTabs = (direction: -1 | 1) => {
    scrollerRef.current?.scrollBy?.({
      left: direction * Math.max(160, scrollerRef.current.clientWidth * 0.65),
      behavior: 'smooth',
    });
  };

  return (
    <div className="flex h-10 shrink-0 items-stretch border-t border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex shrink-0 items-center border-r border-neutral-200 px-1 dark:border-neutral-800">
        <button
          type="button"
          aria-label={t('spreadsheetPreview.previousWorksheets')}
          disabled={disabled || sheets.length <= 1}
          onClick={() => scrollTabs(-1)}
          className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:cursor-default disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={t('spreadsheetPreview.nextWorksheets')}
          disabled={disabled || sheets.length <= 1}
          onClick={() => scrollTabs(1)}
          className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-700 disabled:cursor-default disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label={t('spreadsheetPreview.worksheets')}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {sheets.map((sheet) => {
          const active = sheet.index === activeSheetIndex;
          return (
            <button
              key={sheet.index}
              ref={active ? activeTabRef : undefined}
              type="button"
              role="tab"
              aria-selected={active}
              title={sheet.name}
              disabled={disabled}
              onClick={() => onSelect(sheet.index)}
              className={[
                'relative max-w-52 shrink-0 truncate border-r border-neutral-200 px-5 text-[12px] transition-colors dark:border-neutral-800',
                active
                  ? 'bg-white font-medium text-emerald-700 after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-emerald-600 dark:bg-neutral-900 dark:text-emerald-400 dark:after:bg-emerald-400'
                  : 'text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100',
              ].join(' ')}
            >
              {sheet.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
