import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { cn } from './FormalHostPrimitives';

import { Pagination, PaginationContent, PaginationItem } from './FormalHostPrimitives';

export type PaginatorProps = {
  /** Current 1-based page. */
  page: number;
  /** Total number of pages. */
  pageCount: number;
  onChange: (page: number) => void;
  /** How many page numbers to show on each side of the current page. */
  siblingCount?: number;
  /** Zero-pad page numbers (01, 02, …) to match the SD1 design. Defaults to true. */
  padZero?: boolean;
  className?: string;
  'aria-label'?: string;
};

const PILL_CLASS =
  'flex h-[20px] min-w-[20px] items-center justify-center rounded-[6px] px-[12px] text-[10px] leading-none transition-colors';
const ARROW_CLASS =
  'flex size-[14px] shrink-0 items-center justify-center text-[#464c5e] transition-opacity disabled:cursor-not-allowed disabled:opacity-30';

function getPaginationRange(
  current: number,
  total: number,
  siblingCount: number,
): (number | 'ellipsis')[] {
  const totalNumbers = siblingCount * 2 + 5;
  if (total <= totalNumbers) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const items: (number | 'ellipsis')[] = [1];
  const start = Math.max(2, current - siblingCount);
  const end = Math.min(total - 1, current + siblingCount);
  if (start > 2) items.push('ellipsis');
  for (let page = start; page <= end; page += 1) items.push(page);
  if (end < total - 1) items.push('ellipsis');
  items.push(total);
  return items;
}

/**
 * Global paginator (SD1 design: node 281:2020).
 * Built on the shadcn `Pagination` primitives (nav / ul / li) for structure & a11y,
 * with the SD1 look: 20px pills, 10px zero-padded numbers, `#f6f6f6` active fill,
 * `#999` inactive text, and 14px chevron arrows.
 */
export function Paginator({
  page,
  pageCount,
  onChange,
  siblingCount = 1,
  padZero = true,
  className,
  'aria-label': ariaLabel,
}: PaginatorProps) {
  if (pageCount < 1) return null;
  const range = getPaginationRange(page, pageCount, siblingCount);
  const label = (value: number) => (padZero ? String(value).padStart(2, '0') : String(value));
  const goTo = (target: number) => {
    const next = Math.min(Math.max(target, 1), pageCount);
    if (next !== page) onChange(next);
  };
  return (
    <Pagination aria-label={ariaLabel} className={cn('mt-[16px]', className)}>
      <PaginationContent className="gap-[16px]">
        <PaginationItem>
          <button
            type="button"
            className={ARROW_CLASS}
            disabled={page <= 1}
            onClick={() => goTo(page - 1)}
            aria-label="上一页"
          >
            <ChevronLeftIcon className="size-[14px]" />
          </button>
        </PaginationItem>
        {range.map((item, index) =>
          item === 'ellipsis' ? (
            <PaginationItem key={`ellipsis-${index}`}>
              <span
                aria-hidden="true"
                className="flex h-[20px] items-center justify-center px-[4px] text-[10px] leading-none text-[#999]"
              >
                ···
              </span>
            </PaginationItem>
          ) : (
            <PaginationItem key={item}>
              <button
                type="button"
                aria-current={item === page ? 'page' : undefined}
                onClick={() => goTo(item)}
                className={cn(
                  PILL_CLASS,
                  item === page
                    ? 'bg-[#f6f6f6] text-[#464c5e]'
                    : 'text-[#999] hover:bg-[#f2f3f7] hover:text-[#464c5e]',
                )}
              >
                {label(item)}
              </button>
            </PaginationItem>
          ),
        )}
        <PaginationItem>
          <button
            type="button"
            className={ARROW_CLASS}
            disabled={page >= pageCount}
            onClick={() => goTo(page + 1)}
            aria-label="下一页"
          >
            <ChevronRightIcon className="size-[14px]" />
          </button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
