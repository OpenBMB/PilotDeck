import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { expandingDisclosure } from '../utils/disclosureInteraction';

const BOTTOM_EPSILON = 2;
const ANCHOR_EPSILON = 0.01;
const VIEWPORT_SELECTOR = '[data-stream-scroll-viewport]';
const SCROLL_SOURCE_SELECTOR = `${VIEWPORT_SELECTOR}, [data-chat-scroll-region]`;
const FOLLOW_CHANGE = 'stream-scroll-follow-change';
const LAYOUT_CHANGE = 'stream-scroll-layout-change';
/** Virtual rows can redistribute height while the content's total stays equal. */
export function notifyScrollLayout(node: HTMLElement) { node.dispatchEvent(new Event(LAYOUT_CHANGE)); }
const controllers = new WeakMap<HTMLElement, { resume: () => void; adjustLayout: (top: number) => void }>();
/** A virtualizer correction is layout movement, never a reader gesture. */
export function adjustScrollLayout(node: HTMLElement, top: number) {
  const controller = controllers.get(node);
  if (controller) controller.adjustLayout(top);
  else node.scrollTop = top;
}
export type ReadingAnchor = { key: string; offset: number };
type UserScroll = { top: number; direction: number; expiresAt: number; moved?: boolean; dragging?: boolean };
const GESTURE_IDLE_MS = 250;

/** Keep user intent, viewport geometry, and the return-to-latest affordance separate. */
export function useScrollFollow({
  containerRef, enabled = true, scopeKey, contentKey, contentSelector, canFollow, initialPositionKey,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
  scopeKey?: string | null;
  contentKey?: unknown;
  contentSelector?: string;
  canFollow?: () => boolean;
  initialPositionKey?: unknown;
}) {
  const [isPaused, setIsPaused] = useState(false);
  const [canReturnToLatest, setCanReturnToLatest] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const pausedRef = useRef(false);
  const optionsRef = useRef({ enabled, canFollow, initialPositionKey });
  optionsRef.current = { enabled, canFollow, initialPositionKey };
  const frameRef = useRef<number | null>(null);
  const initialFrameRef = useRef(false);
  const anchorRef = useRef<ReadingAnchor | null>(null);
  const anchorElementRef = useRef<HTMLElement | null>(null);
  const anchorAwaitingRowsRef = useRef(false);
  const metricsRef = useRef({ top: 0, height: 0, viewport: 0 });
  const programmaticTopRef = useRef<number | null>(null);
  const userScrollRef = useRef<UserScroll | null>(null);

  const publishAnchorKey = useCallback((row: HTMLElement | null) => {
    const node = containerRef.current;
    if (!node) return;
    // The virtualizer owns top-level rows; the reading anchor may be a child
    // deep inside one process row. Keep both identities at their own boundary.
    let virtualRow = row;
    for (let parent = row?.parentElement?.closest<HTMLElement>('[data-message-key]');
      parent && node.contains(parent); parent = parent.parentElement?.closest<HTMLElement>('[data-message-key]')) {
      virtualRow = parent;
    }
    if (virtualRow) node.dataset.readingAnchorKey = virtualRow.dataset.messageKey;
    else delete node.dataset.readingAnchorKey;
  }, [containerRef]);

  const cancelFollow = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    initialFrameRef.current = false;
  }, []);

  const updateAvailability = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    setHasOverflow(node.scrollHeight - node.clientHeight > BOTTOM_EPSILON);
    setCanReturnToLatest([node, ...node.querySelectorAll<HTMLElement>(VIEWPORT_SELECTOR)].some((viewport) => (
      viewport.clientHeight > 0
      && (viewport.dataset.scrollFollowPaused === 'true' || (viewport === node && !optionsRef.current.enabled))
      && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > BOTTOM_EPSILON
    )));
  }, [containerRef]);

  const publish = useCallback(() => {
    updateAvailability();
    containerRef.current?.dispatchEvent(new Event(FOLLOW_CHANGE, { bubbles: true }));
  }, [containerRef, updateAvailability]);

  const rememberMetrics = useCallback(() => {
    const node = containerRef.current;
    if (node) metricsRef.current = { top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight };
  }, [containerRef]);

  const writePosition = useCallback((top: number) => {
    const node = containerRef.current;
    if (!node) return;
    const previous = node.scrollTop;
    node.scrollTop = top;
    programmaticTopRef.current = node.scrollTop;
    // A wheel/touch gesture can still have compositor frames in flight when
    // media or virtual rows resize. Rebase its origin by our correction only.
    if (userScrollRef.current) userScrollRef.current.top += node.scrollTop - previous;
  }, [containerRef]);

  const captureAnchor = useCallback((messageKey?: string) => {
    const node = containerRef.current;
    if (!node || !contentSelector) return;
    const top = node.getBoundingClientRect().top;
    const rows = node.querySelectorAll<HTMLElement>('[data-message-key]');
    let row: HTMLElement | undefined;
    let rect: DOMRect | undefined;
    if (typeof messageKey === 'string') row = Array.from(rows).find(item => item.dataset.messageKey === messageKey);
    if (row) rect = row.getBoundingClientRect();
    else for (const candidate of rows) {
      if (row && !row.contains(candidate)) break;
      if (candidate.closest('[inert]')) continue;
      const bounds = candidate.getBoundingClientRect();
      if (bounds.bottom <= top || bounds.top >= top + node.clientHeight || bounds.bottom <= bounds.top) continue;
      if (!row || row.contains(candidate)) { row = candidate; rect = bounds; }
    }
    anchorElementRef.current = row ?? null;
    anchorRef.current = row && rect ? { key: row.dataset.messageKey!, offset: rect.top - top } : null;
    // A large native scroll can outrun the virtual window for one frame.
    // Its first mounted row may now be entirely below the viewport. Keeping
    // that offscreen row as the reading anchor would steer later measurements
    // toward a row the reader has already left.
    anchorAwaitingRowsRef.current = !messageKey && (!rect || rect.top >= top + node.clientHeight);
    // Retain an offscreen row only as a signal to reacquire the virtual window.
    if (!row && !messageKey) {
      row = Array.from(rows).find(item => !item.closest('[inert]') && item.getBoundingClientRect().bottom > top);
      rect = row?.getBoundingClientRect();
      anchorElementRef.current = row ?? null;
      anchorRef.current = row && rect ? { key: row.dataset.messageKey!, offset: rect.top - top } : null;
      anchorAwaitingRowsRef.current = true;
    }
    publishAnchorKey(anchorAwaitingRowsRef.current ? null : row ?? null);
  }, [containerRef, contentSelector, publishAnchorKey]);

  const restoreAnchor = useCallback(() => {
    const node = containerRef.current;
    if (node && anchorAwaitingRowsRef.current) {
      captureAnchor();
      rememberMetrics();
      return;
    }
    const anchor = anchorRef.current;
    if (!node || !anchor) return;
    let row = anchorElementRef.current;
    if (!row || row.dataset.messageKey !== anchor.key || !node.contains(row)) {
      row = Array.from(node.querySelectorAll<HTMLElement>('[data-message-key]'))
        .find((item) => item.dataset.messageKey === anchor.key) ?? null;
      anchorElementRef.current = row;
    }
    if (!row) return;
    // Retained disclosure contents still have geometry while closing, but
    // cannot remain the reading anchor once they are hidden from the reader.
    if (row.closest('[inert]')) { captureAnchor(); rememberMetrics(); return; }
    publishAnchorKey(row);
    const delta = row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > ANCHOR_EPSILON) {
      const targetTop = node.scrollTop + delta;
      writePosition(targetTop);
      // Shrinking content can make the old offset unreachable. Adopt the
      // clamped position so later growth cannot replay that stale correction.
      if (Math.abs(node.scrollTop - targetTop) > ANCHOR_EPSILON) captureAnchor();
    }
    rememberMetrics();
  }, [containerRef, rememberMetrics, captureAnchor, writePosition, publishAnchorKey]);

  const getReadingAnchor = useCallback(() => !anchorAwaitingRowsRef.current && anchorRef.current ? { ...anchorRef.current } : null, []);
  const restoreReadingAnchor = useCallback((anchor: ReadingAnchor) => {
    anchorAwaitingRowsRef.current = false;
    anchorRef.current = { ...anchor };
    if (containerRef.current) containerRef.current.dataset.readingAnchorKey = anchor.key;
    restoreAnchor();
  }, [containerRef, restoreAnchor]);

  const setPaused = useCallback((paused: boolean) => {
    pausedRef.current = paused;
    setIsPaused(paused);
    if (containerRef.current) containerRef.current.dataset.scrollFollowPaused = String(paused);
    if (paused) {
      cancelFollow();
      captureAnchor();
    } else {
      anchorRef.current = null;
      anchorElementRef.current = null;
      anchorAwaitingRowsRef.current = false;
      if (containerRef.current) delete containerRef.current.dataset.readingAnchorKey;
    }
    publish();
  }, [cancelFollow, captureAnchor, containerRef, publish]);

  // A resize can run before the browser delivers scroll. Account for the actual
  // user displacement before any anchor restoration, including in that order.
  const acceptUserDisplacement = useCallback(() => {
    const node = containerRef.current;
    const input = userScrollRef.current;
    if (!node || !input) return false;
    if (!input.dragging && Date.now() > input.expiresAt) { userScrollRef.current = null; return false; }
    const delta = node.scrollTop - input.top;
    // Wheel/touch intent can reverse before the compositor has delivered the
    // previous gesture's final frames. Both directions still belong to the
    // reader; rejecting the old momentum makes anchor restoration undo it on
    // every streaming resize, producing a visible back-and-forth jump.
    if (!delta) return false;
    const previous = metricsRef.current;
    const layoutChanged = node.scrollHeight !== previous.height || node.clientHeight !== previous.viewport;
    if (layoutChanged && anchorRef.current) {
      // Preserve the reader's gesture AND any independent insertion above it.
      anchorRef.current.offset -= delta;
      restoreAnchor();
    }
    captureAnchor();
    // One native gesture produces multiple scroll frames (smooth wheels,
    // touch inertia and PageUp/Down). Keep ownership until scrollend/idle.
    userScrollRef.current = { ...input, moved: true, top: node.scrollTop,
      expiresAt: input.expiresAt === Infinity ? Infinity : Date.now() + GESTURE_IDLE_MS };
    rememberMetrics();
    return true;
  }, [containerRef, captureAnchor, rememberMetrics, restoreAnchor]);

  const writeBottom = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    writePosition(Math.max(0, node.scrollHeight - node.clientHeight));
    if (!optionsRef.current.enabled) captureAnchor();
    rememberMetrics();
    publish();
  }, [containerRef, captureAnchor, rememberMetrics, publish, writePosition]);

  const queuePosition = useCallback((initial: boolean) => {
    const initialKey = optionsRef.current.initialPositionKey;
    const allowed = () => !pausedRef.current
      && (!initial || optionsRef.current.initialPositionKey === initialKey)
      && (initial || optionsRef.current.enabled) && (optionsRef.current.canFollow?.() ?? true);
    if (!allowed()) return;
    if (initial) cancelFollow();
    if (frameRef.current !== null) return;
    initialFrameRef.current = initial;
    let previousSize = '';
    let stableFrames = 0;
    let attempts = 0;
    const position = () => {
      frameRef.current = null;
      if (!allowed()) { initialFrameRef.current = false; return; }
      writeBottom();
      const node = containerRef.current;
      const size = `${node?.scrollHeight}:${node?.clientHeight}`;
      stableFrames = size === previousSize ? stableFrames + 1 : 0;
      previousSize = size;
      // Initial virtual rows can replace their estimates over several frames.
      // Settle that first landing even with automatic following disabled. Any
      // reader gesture/disclosure cancels this bounded initialization lease.
      if (initial && stableFrames < 3 && ++attempts < 12) frameRef.current = requestAnimationFrame(position);
      else initialFrameRef.current = false;
    };
    frameRef.current = requestAnimationFrame(position);
  }, [cancelFollow, containerRef, writeBottom]);
  const scheduleFollow = useCallback(() => queuePosition(false), [queuePosition]);
  const scheduleInitialPosition = useCallback(() => queuePosition(true), [queuePosition]);
  const getIsPaused = useCallback(() => pausedRef.current, []);
  const pause = useCallback(() => setPaused(true), [setPaused]);
  const pauseAt = useCallback((messageKey?: string) => {
    userScrollRef.current = null;
    setPaused(true);
    // A search hit may be nested deep inside one expanded process row. Keep
    // that message steady while the process above it finishes measuring.
    if (messageKey) captureAnchor(messageKey);
  }, [setPaused, captureAnchor]);

  const resumeOwnViewport = useCallback(() => {
    cancelFollow();
    userScrollRef.current = null;
    setPaused(false);
    writeBottom();
    scheduleFollow();
  }, [cancelFollow, setPaused, writeBottom, scheduleFollow]);
  const scrollToBottom = useCallback(() => {
    // The global control represents all visible nested viewports as well.
    const nested = containerRef.current?.querySelectorAll<HTMLElement>(VIEWPORT_SELECTOR) ?? [];
    Array.from(nested).reverse().forEach((viewport) => {
      if (viewport.clientHeight > 0) controllers.get(viewport)?.resume();
    });
    resumeOwnViewport();
  }, [containerRef, resumeOwnViewport]);

  useLayoutEffect(() => {
    cancelFollow();
    anchorRef.current = null;
    anchorElementRef.current = null;
    if (containerRef.current) delete containerRef.current.dataset.readingAnchorKey;
    programmaticTopRef.current = null;
    userScrollRef.current = null;
    setPaused(false);
    rememberMetrics();
    return cancelFollow;
  }, [scopeKey, cancelFollow, containerRef, rememberMetrics, setPaused]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let touchY: number | null = null;
    // Native scrolling can run on the compositor while Markdown/tool rendering
    // blocks this thread. Wall time alone cannot end that gesture: its delayed
    // scroll events still belong to the reader. Current desktop engines signal
    // the actual end; retain the idle fallback only for older browsers.
    const supportsScrollEnd = 'onscrollend' in node;
    const gestureDeadline = () => supportsScrollEnd ? Infinity : Date.now() + GESTURE_IDLE_MS;
    const atBottom = () => node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_EPSILON;
    const sourceViewport = (target: EventTarget | null, direction = 0) => {
      let source = target instanceof Element ? target.closest<HTMLElement>(SCROLL_SOURCE_SELECTOR) ?? node : node;
      // Native code/tool regions consume input until the directional edge,
      // then let the browser chain it to the conversation. The parent must
      // accept that displacement without resuming while only the child moves.
      while (source !== node) {
        const remaining = source.scrollHeight - source.clientHeight;
        const atEdge = direction < 0 ? source.scrollTop <= BOTTOM_EPSILON
          : direction > 0 && remaining - source.scrollTop <= BOTTOM_EPSILON;
        if (remaining > BOTTOM_EPSILON && !(atEdge && source.hasAttribute('data-chat-scroll-region'))) break;
        source = source.parentElement?.closest<HTMLElement>(SCROLL_SOURCE_SELECTOR) ?? node;
      }
      return source;
    };
    const beginUpwardInput = (target: EventTarget | null) => {
      const source = sourceViewport(target, -1);
      if (source.scrollHeight - source.clientHeight <= BOTTOM_EPSILON) return;
      setPaused(true);
      if (source === node) {
        programmaticTopRef.current = null;
        userScrollRef.current = { top: node.scrollTop, direction: -1, expiresAt: gestureDeadline(),
          moved: node.scrollTop !== metricsRef.current.top };
      }
    };
    const beginDownwardInput = (target: EventTarget | null) => {
      if (sourceViewport(target, 1) !== node) return;
      if (atBottom()) scrollToBottom();
      else {
        const moved = node.scrollTop !== metricsRef.current.top;
        // The compositor can move before delivering wheel. Adopt that reading
        // position now, before reflow can restore the preceding gesture's anchor.
        if (moved) captureAnchor();
        userScrollRef.current = { top: node.scrollTop, direction: 1, expiresAt: gestureDeadline(), moved };
      }
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (event.deltaY < 0) beginUpwardInput(event.target);
      else if (event.deltaY > 0) beginDownwardInput(event.target);
    };
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (nextY !== null && touchY !== null && nextY > touchY) beginUpwardInput(event.target);
      else if (nextY !== null && touchY !== null && nextY < touchY) beginDownwardInput(event.target);
      touchY = nextY;
    };
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      // Preserve activation and selection in controls. Only the viewport owns
      // these keys; nested output regions retain their native scrolling.
      if (event.key === ' ' && target instanceof Element && target.closest('button, a, summary, [role="button"]')) return;
      const direction = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey) ? -1
        : ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) ? 1 : 0;
      if (!direction || (event.shiftKey && event.key !== ' ')) return;
      if (sourceViewport(target, direction) === node) {
        event.preventDefault();
        if (event.key === 'End') { scrollToBottom(); return; }
        setPaused(true);
        programmaticTopRef.current = null;
        userScrollRef.current = null;
        // Native key animations compete with measurement corrections, which
        // can terminate Home/End halfway through a virtualized conversation.
        // Apply one reader movement before reacquiring its visible anchor.
        const step = event.key.startsWith('Arrow') ? 40 : node.clientHeight * 0.9;
        node.scrollTop = event.key === 'Home' ? 0 : node.scrollTop + direction * step;
        captureAnchor();
        rememberMetrics();
        if (direction > 0 && atBottom()) scrollToBottom();
        else publish();
        return;
      }
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) beginUpwardInput(target);
      else if (event.key === 'End' && sourceViewport(target) === node) scrollToBottom();
      else if (['ArrowDown', 'PageDown', ' '].includes(event.key)) beginDownwardInput(target);
    };
    const pointerDown = (event: PointerEvent) => {
      // A click in blank content is not a scrollbar drag.
      const source = sourceViewport(event.target);
      if (event.target === source && source.scrollHeight > source.clientHeight
        && event.clientX >= source.getBoundingClientRect().right - 16) {
        setPaused(true);
        if (source === node) userScrollRef.current = { top: node.scrollTop, direction: 0, dragging: true, expiresAt: Infinity };
      }
    };
    const pointerUp = () => { if (userScrollRef.current?.dragging) userScrollRef.current = null; };
    const click = (event: MouseEvent) => {
      const trigger = expandingDisclosure(event.target);
      if (trigger) pauseAt(trigger.closest<HTMLElement>('[data-message-key]')?.dataset.messageKey);
    };
    const layout = () => {
      acceptUserDisplacement();
      if (pausedRef.current || !optionsRef.current.enabled) restoreAnchor();
      else scheduleFollow();
      publish();
    };
    const scroll = () => {
      const previous = metricsRef.current;
      const top = node.scrollTop;
      const direction = userScrollRef.current?.direction;
      const userMoved = acceptUserDisplacement();
      if (!userMoved && programmaticTopRef.current !== null && Math.abs(top - programmaticTopRef.current) < 0.5) {
        programmaticTopRef.current = null;
        rememberMetrics();
        publish();
        return;
      }
      programmaticTopRef.current = null;
      // Layout clamping, focus and our own writes also emit scroll events.
      // Only an actual gesture can hand ownership back to automatic following.
      if (userMoved && direction !== undefined && direction >= 0 && top > previous.top && atBottom()) scrollToBottom();
      // acceptUserDisplacement already captured the new reading position.
      // Measurement writes must not replace it before its virtual row settles.
      if (!pausedRef.current && !atBottom()) scheduleFollow();
      rememberMetrics();
      publish();
    };
    const scrollEnd = (event: Event) => {
      // A previous scroll (including our layout writes) can finish after the
      // next wheel event, before that new gesture has moved the viewport.
      const input = userScrollRef.current;
      if (event.target === node && input?.moved && !input.dragging) userScrollRef.current = null;
    };
    controllers.set(node, { resume: resumeOwnViewport, adjustLayout: writePosition });
    const nestedFollowChanged = (event: Event) => {
      // publish already updated this viewport; only nested controllers need a rescan.
      if (event.target !== node) updateAvailability();
    };
    node.addEventListener(FOLLOW_CHANGE, nestedFollowChanged);
    node.addEventListener(LAYOUT_CHANGE, layout);
    node.addEventListener('wheel', wheel, { capture: true, passive: true });
    node.addEventListener('touchstart', touchStart, { capture: true, passive: true });
    node.addEventListener('touchmove', touchMove, { capture: true, passive: true });
    node.addEventListener('keydown', keyDown, true);
    node.addEventListener('pointerdown', pointerDown, true);
    node.addEventListener('click', click, true);
    window.addEventListener('pointerup', pointerUp);
    node.addEventListener('scroll', scroll, { passive: true });
    node.addEventListener('scrollend', scrollEnd);
    rememberMetrics();
    return () => {
      controllers.delete(node);
      node.removeEventListener(FOLLOW_CHANGE, nestedFollowChanged);
      node.removeEventListener(LAYOUT_CHANGE, layout);
      node.removeEventListener('wheel', wheel, true);
      node.removeEventListener('touchstart', touchStart, true);
      node.removeEventListener('touchmove', touchMove, true);
      node.removeEventListener('keydown', keyDown, true);
      node.removeEventListener('pointerdown', pointerDown, true);
      node.removeEventListener('click', click, true);
      window.removeEventListener('pointerup', pointerUp);
      node.removeEventListener('scroll', scroll);
      node.removeEventListener('scrollend', scrollEnd);
    };
  }, [containerRef, scopeKey, contentKey, acceptUserDisplacement, captureAnchor, rememberMetrics, publish, resumeOwnViewport, scrollToBottom, setPaused, updateAvailability, pauseAt, scheduleFollow, restoreAnchor, writePosition]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    const content = contentSelector ? node?.querySelector(contentSelector) : node?.firstElementChild;
    if (!node || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      acceptUserDisplacement();
      if (pausedRef.current || !optionsRef.current.enabled) restoreAnchor();
      else scheduleFollow();
      publish();
    });
    observer.observe(content);
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerRef, contentSelector, scopeKey, contentKey, acceptUserDisplacement, restoreAnchor, scheduleFollow, publish]);

  useLayoutEffect(() => {
    acceptUserDisplacement();
    if (pausedRef.current || !enabled) {
      if (pausedRef.current || !initialFrameRef.current) cancelFollow();
      restoreAnchor();
      if (!anchorRef.current) captureAnchor();
    } else scheduleFollow();
    publish();
  });

  return { isPaused, canReturnToLatest, hasOverflow, setPaused, getIsPaused, pause, pauseAt, scrollToBottom, scheduleFollow, scheduleInitialPosition, cancelFollow, captureAnchor, getReadingAnchor, restoreReadingAnchor };
}
