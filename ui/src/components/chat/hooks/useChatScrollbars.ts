import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Delegate to actual scroll targets, including horizontal code/table output. */
export function useChatScrollbars(containerRef: RefObject<HTMLElement | null>) {
  const attached = useRef<{ root: HTMLElement; dispose: () => void } | null>(null);
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (attached.current?.root === root) return;
    attached.current?.dispose();
    attached.current = null;
    if (!root) return;
    root.dataset.chatScrollbars = '';
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('[data-chat-scrollbars]') !== root) return;
      clearTimeout(timers.get(target));
      target.dataset.chatScrolling = '';
      timers.set(target, setTimeout(() => {
        delete target.dataset.chatScrolling;
        timers.delete(target);
      }, 800));
    };
    root.addEventListener('scroll', onScroll, true);
    attached.current = { root, dispose: () => {
      root.removeEventListener('scroll', onScroll, true);
      delete root.dataset.chatScrollbars;
      for (const [target, timer] of timers) {
        clearTimeout(timer);
        delete target.dataset.chatScrolling;
      }
    } };
  });
  useLayoutEffect(() => () => {
    attached.current?.dispose();
    attached.current = null;
  }, []);
}
