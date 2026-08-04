import { useCallback, type RefObject } from 'react';
import { useRegisterFindShortcutTarget } from '../../../contexts/FindShortcutContext';

type UseFileSearchShortcutOptions = {
  containerRef: RefObject<HTMLElement>;
  enabled?: boolean;
  onOpen: () => void;
};

export function useFileSearchShortcut({
  containerRef,
  enabled = true,
  onOpen,
}: UseFileSearchShortcutOptions) {
  const openFromShortcut = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    onOpen();
    window.requestAnimationFrame(() => {
      const input = container.querySelector<HTMLInputElement>('[data-file-search-input]');
      input?.focus();
      input?.select();
    });
  }, [containerRef, onOpen]);

  useRegisterFindShortcutTarget({
    scope: 'file',
    containerRef,
    enabled,
    onOpen: openFromShortcut,
  });
}
