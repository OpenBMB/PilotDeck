import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

const BOTTOM_EPSILON = 2;

type ReadingAnchor = { key: string; offset: number };

/** A scroll gesture owns the viewport until the reader explicitly returns to its end. */
export function useScrollFollow({
  containerRef,
  enabled = true,
  scopeKey,
  contentKey,
  contentSelector,
  canFollow,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
  scopeKey?: string | null;
  contentKey?: unknown;
  contentSelector?: string;
  canFollow?: () => boolean;
}) {
  const [isPaused, setIsPaused] = useState(false);
  const pausedRef = useRef(false);
  const optionsRef = useRef({ enabled, canFollow });
  optionsRef.current = { enabled, canFollow };
  const frameRef = useRef<number | null>(null);
  const anchorRef = useRef<ReadingAnchor | null>(null);
  const metricsRef = useRef({ top: 0, height: 0, viewport: 0 });
  const programmaticTopRef = useRef<number | null>(null);

  const cancelFollow = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const rememberMetrics = useCallback(() => {
    const node = containerRef.current;
    if (node) metricsRef.current = { top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight };
  }, [containerRef]);

  const captureAnchor = useCallback(() => {
    const node = containerRef.current;
    if (!node || !contentSelector) return;
    const top = node.getBoundingClientRect().top;
    const row = Array.from(node.querySelectorAll<HTMLElement>('[data-message-key]'))
      .find((item) => item.getBoundingClientRect().bottom > top);
    anchorRef.current = row ? { key: row.dataset.messageKey!, offset: row.getBoundingClientRect().top - top } : null;
    if (row) node.dataset.readingAnchorKey = row.dataset.messageKey;
    else delete node.dataset.readingAnchorKey;
  }, [containerRef, contentSelector]);

  const restoreAnchor = useCallback(() => {
    const node = containerRef.current;
    const anchor = anchorRef.current;
    if (!node || !anchor) return;
    const row = Array.from(node.querySelectorAll<HTMLElement>('[data-message-key]'))
      .find((item) => item.dataset.messageKey === anchor.key);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 0.5) {
      node.scrollTop += delta;
      programmaticTopRef.current = node.scrollTop;
    }
    rememberMetrics();
  }, [containerRef, rememberMetrics]);

  const setPaused = useCallback((paused: boolean) => {
    pausedRef.current = paused;
    setIsPaused(paused);
    if (paused) {
      cancelFollow();
      captureAnchor();
    } else {
      anchorRef.current = null;
      if (containerRef.current) delete containerRef.current.dataset.readingAnchorKey;
    }
  }, [cancelFollow, captureAnchor, containerRef]);

  const writeBottom = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    programmaticTopRef.current = node.scrollTop;
    rememberMetrics();
  }, [containerRef, rememberMetrics]);

  const scheduleFollow = useCallback(() => {
    if (frameRef.current !== null) return;
    const allowed = () => !pausedRef.current && optionsRef.current.enabled && (optionsRef.current.canFollow?.() ?? true);
    if (!allowed()) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      // Input may have arrived after the resize notification queued this frame.
      if (allowed()) writeBottom();
    });
  }, [writeBottom]);

  const getIsPaused = useCallback(() => pausedRef.current, []);
  const pause = useCallback(() => setPaused(true), [setPaused]);

  const scrollToBottom = useCallback(() => {
    cancelFollow();
    setPaused(false);
    writeBottom();
    scheduleFollow();
  }, [cancelFollow, setPaused, writeBottom, scheduleFollow]);

  useLayoutEffect(() => {
    cancelFollow();
    anchorRef.current = null;
    if (containerRef.current) delete containerRef.current.dataset.readingAnchorKey;
    programmaticTopRef.current = null;
    pausedRef.current = false;
    setIsPaused(false);
    rememberMetrics();
    return cancelFollow;
  }, [scopeKey, cancelFollow, containerRef, rememberMetrics]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let touchY: number | null = null;
    const atBottom = () => node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_EPSILON;
    const isNested = (target: EventTarget | null) => target instanceof Element
      && target.closest('[data-stream-scroll-viewport]') !== node;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (event.deltaY < 0) setPaused(true);
      else if (event.deltaY > 0 && !isNested(event.target) && atBottom()) scrollToBottom();
    };
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (nextY !== null && touchY !== null && nextY > touchY) setPaused(true);
      else if (nextY !== null && touchY !== null && nextY < touchY && !isNested(event.target) && atBottom()) scrollToBottom();
      touchY = nextY;
    };
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) setPaused(true);
      else if (event.key === 'End' && !isNested(target)) scrollToBottom();
    };
    const pointerDown = (event: PointerEvent) => {
      // Scrollbar dragging has no wheel event; pause before the next queued frame.
      if (event.target === node) setPaused(true);
    };
    const scroll = () => {
      const previous = metricsRef.current;
      const top = node.scrollTop;
      if (programmaticTopRef.current !== null && Math.abs(top - programmaticTopRef.current) < 0.5) {
        programmaticTopRef.current = null;
        rememberMetrics();
        return;
      }
      programmaticTopRef.current = null;
      const layoutChanged = node.scrollHeight !== previous.height || node.clientHeight !== previous.viewport;
      if (!layoutChanged) {
        if (top < previous.top) setPaused(true);
        else if (top > previous.top && atBottom()) setPaused(false);
        if (pausedRef.current || !optionsRef.current.enabled) captureAnchor();
      }
      rememberMetrics();
    };
    // Capture upward intent inside nested reasoning too: the conversation must
    // not move underneath someone reading that reasoning when a tool arrives.
    node.addEventListener('wheel', wheel, { capture: true, passive: true });
    node.addEventListener('touchstart', touchStart, { capture: true, passive: true });
    node.addEventListener('touchmove', touchMove, { capture: true, passive: true });
    node.addEventListener('keydown', keyDown, true);
    node.addEventListener('pointerdown', pointerDown, true);
    node.addEventListener('scroll', scroll, { passive: true });
    rememberMetrics();
    return () => {
      node.removeEventListener('wheel', wheel, true);
      node.removeEventListener('touchstart', touchStart, true);
      node.removeEventListener('touchmove', touchMove, true);
      node.removeEventListener('keydown', keyDown, true);
      node.removeEventListener('pointerdown', pointerDown, true);
      node.removeEventListener('scroll', scroll);
    };
  }, [containerRef, scopeKey, contentKey, captureAnchor, rememberMetrics, scrollToBottom, setPaused]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    const content = contentSelector ? node?.querySelector(contentSelector) : node?.firstElementChild;
    if (!node || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pausedRef.current || !optionsRef.current.enabled) restoreAnchor();
      else scheduleFollow();
    });
    observer.observe(content);
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerRef, contentSelector, scopeKey, contentKey, restoreAnchor, scheduleFollow]);

  useLayoutEffect(() => {
    if (pausedRef.current || !enabled) {
      cancelFollow();
      restoreAnchor();
      if (!anchorRef.current) captureAnchor();
    } else scheduleFollow();
  });

  return { isPaused, setPaused, getIsPaused, pause, scrollToBottom, scheduleFollow, cancelFollow, captureAnchor };
}
