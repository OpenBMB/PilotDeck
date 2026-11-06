import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const EDGE = 12;
const GAP = 8;
const MENU_WIDTH = 256;
const ADVANCED_WIDTH = 212;
type Viewport = { left: number; top: number; width: number; height: number };
type Anchor = { left: number; top: number; right: number; bottom: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function placeModelMenu(anchor: Anchor, viewport: Viewport, menuHeight: number, advancedHeight: number) {
  const leftEdge = viewport.left + EDGE;
  const topEdge = viewport.top + EDGE;
  const rightEdge = viewport.left + viewport.width - EDGE;
  const bottomEdge = viewport.top + viewport.height - EDGE;
  const width = Math.max(0, Math.min(MENU_WIDTH, rightEdge - leftEdge));
  const left = clamp((anchor.left + anchor.right - width) / 2, leftEdge, rightEdge - width);
  const above = clamp(anchor.top - GAP - topEdge, 0, bottomEdge - topEdge);
  const below = clamp(bottomEdge - anchor.bottom - GAP, 0, bottomEdge - topEdge);
  const opensUp = above >= menuHeight || above >= below;
  const maxHeight = opensUp ? above : below;
  const height = Math.min(menuHeight, maxHeight);
  const top = clamp(opensUp ? anchor.top - GAP - height : anchor.bottom + GAP, topEdge, bottomEdge - height);
  const rightFits = left + width + GAP + ADVANCED_WIDTH <= rightEdge;
  const leftFits = left - GAP - ADVANCED_WIDTH >= leftEdge;
  const inline = !rightFits && !leftFits;
  return {
    inline,
    side: rightFits ? 'right' : leftFits ? 'left' : 'inline',
    menu: { position: 'fixed', left, top, width, maxHeight } as CSSProperties,
    advanced: inline
      ? { position: 'relative', width: '100%', maxHeight } as CSSProperties
      : { position: 'fixed', width: ADVANCED_WIDTH, left: rightFits ? left + width + GAP : left - GAP - ADVANCED_WIDTH,
          top: clamp(top + 24, topEdge, bottomEdge - Math.min(advancedHeight, bottomEdge - topEdge)),
          maxHeight: Math.max(0, bottomEdge - topEdge) } as CSSProperties,
  };
}

export function useModelMenuLayout(open: boolean, advancedOpen: boolean, onClose: () => void) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const advancedRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [layout, setLayout] = useState<ReturnType<typeof placeModelMenu> | null>(null);

  useLayoutEffect(() => {
    if (!open) { setLayout(null); return; }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const update = () => {
      if (!trigger.isConnected || trigger.closest('[aria-hidden="true"]') || getComputedStyle(trigger).visibility === 'hidden') {
        closeRef.current();
        return;
      }
      const viewport = window.visualViewport;
      const outerHeight = (element: HTMLElement) => element.scrollHeight + element.offsetHeight - element.clientHeight;
      const list = menu.querySelector<HTMLElement>('[data-model-list]');
      const advanced = advancedRef.current;
      const inlineAdvanced = advanced?.dataset.side === 'inline';
      const menuHeight = list && !inlineAdvanced
        ? Math.min(list.scrollHeight, 256) + menu.offsetHeight - list.clientHeight
        : inlineAdvanced && advanced ? outerHeight(advanced) + menu.offsetHeight - menu.clientHeight : outerHeight(menu);
      const next = placeModelMenu(trigger.getBoundingClientRect(), {
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? document.documentElement.clientWidth,
        height: viewport?.height ?? document.documentElement.clientHeight,
      }, menuHeight, advanced ? outerHeight(advanced) : 0);
      setLayout(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const contains = (target: EventTarget | null) => target instanceof Node && (trigger.contains(target) || menu.contains(target));
    const dismissOutside = (event: Event) => { if (!contains(event.target)) closeRef.current(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      trigger.focus();
    };
    const observer = new ResizeObserver(update);
    for (let node: HTMLElement | null = trigger; node; node = node.parentElement) observer.observe(node);
    observer.observe(menu);
    const composer = trigger.closest('.pd-composer-container');
    if (composer) observer.observe(composer);
    if (advancedRef.current) observer.observe(advancedRef.current);
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', escape, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, advancedOpen]);

  return { triggerRef, menuRef, advancedRef, inline: layout?.inline ?? false, side: layout?.side,
    menuStyle: layout?.menu ?? { position: 'fixed', width: MENU_WIDTH, visibility: 'hidden' } as CSSProperties,
    advancedStyle: layout?.advanced };
}
