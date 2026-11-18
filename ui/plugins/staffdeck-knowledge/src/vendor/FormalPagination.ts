import { useEffect, useMemo, useState } from 'react';

export type ClientPagination<T> = {
  /** Current 1-based page. */
  page: number;
  setPage: (page: number) => void;
  /** Total number of pages (never below 1). */
  pageCount: number;
  /** Items belonging to the current page. */
  pagedItems: T[];
};

/**
 * Client-side pagination over an in-memory list.
 *
 * Clamps the current page when the list shrinks and resets back to page 1
 * whenever `resetKey` changes (e.g. when a filter is switched).
 */
export function useClientPagination<T>(
  items: T[],
  pageSize: number,
  resetKey?: unknown,
): ClientPagination<T> {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  useEffect(() => {
    setPage((prev) => Math.min(prev, pageCount));
  }, [pageCount]);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const pagedItems = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize],
  );

  return { page, setPage, pageCount, pagedItems };
}
