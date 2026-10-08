import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

type Rect = { left: number; right: number; top: number; bottom: number };
type Viewport = { left: number; top: number; width: number; height: number };
type Options = { width?: number; maxHeight?: number; side?: 'above' | 'below'; matchComposer?: boolean };

export function placeFloatingPanel(anchor: Rect, viewport: Viewport, width: number, height: number, side = 'above'): CSSProperties {
  const edge = 8;
  const left = viewport.left + edge;
  const right = viewport.left + viewport.width - edge;
  const top = viewport.top + edge;
  const bottom = viewport.top + viewport.height - edge;
  const above = Math.max(0, Math.min(anchor.top - edge, bottom) - top);
  const below = Math.max(0, bottom - Math.max(anchor.bottom + edge, top));
  const opensUp = side === 'above' ? above >= height || above >= below : !(below >= height || below >= above);
  const panelWidth = Math.max(0, Math.min(width, right - left));
  return {
    position: 'fixed', zIndex: 100,
    left: Math.max(left, Math.min(anchor.left, right - panelWidth)), width: panelWidth,
    top: opensUp ? Math.min(bottom, Math.max(top, anchor.top - edge)) : Math.max(top, Math.min(bottom, anchor.bottom + edge)),
    transform: opensUp ? 'translateY(-100%)' : undefined,
    maxHeight: Math.min(height, opensUp ? above : below),
  };
}

/** Render the panel in a portal; keep its anchor and viewport bounds current. */
export function useFloatingPanel(open: boolean, anchorRef: RefObject<HTMLElement | null>, onClose?: () => void, { width = 280, maxHeight = 400, side = 'above', matchComposer = false }: Options = {}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const update = () => {
      if (!anchor.isConnected || anchor.closest('[aria-hidden="true"]') || getComputedStyle(anchor).visibility === 'hidden') {
        closeRef.current?.();
        setStyle(current => current.visibility === 'hidden' ? current : { position: 'fixed', visibility: 'hidden' });
        return;
      }
      const viewport = window.visualViewport;
      const composerWidth = anchor.closest('.pd-composer-container')?.getBoundingClientRect().width;
      const next = placeFloatingPanel(anchor.getBoundingClientRect(), {
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
      }, matchComposer ? Math.max(260, Math.min(480, composerWidth ?? width)) : width, maxHeight, side);
      setStyle(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const outside = (event: Event) => {
      if (event.target instanceof Node && !anchor.contains(event.target) && !panel.contains(event.target)) closeRef.current?.();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !closeRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      anchor.focus();
    };
    const observer = new ResizeObserver(update);
    // Ancestor resizing can move an unchanged-size trigger (e.g. a split pane).
    for (let node: HTMLElement | null = anchor; node; node = node.parentElement) observer.observe(node);
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, anchorRef, width, maxHeight, side, matchComposer]);
  return { panelRef, style };
}
