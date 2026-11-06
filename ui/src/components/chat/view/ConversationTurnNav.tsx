import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '../types/types';
import { getIntrinsicMessageKey } from '../utils/messageKeys';
import { buildConversationTurns } from '../utils/conversationTurnNavUtils';
import { scrollToMessageIndex } from '../utils/chatHistorySearchUtils';

const PITCH = 10;
/** Fixed-pitch turn marks and bounded previews; work details never enter the outline. */
export function ConversationTurnNav({ messages, items, heights, scrollRef, onPause, loadAll, hasMore, loading }: {
  messages: ChatMessage[];
  items: { message: ChatMessage; itemKey: string; renderIndex: number }[];
  heights: number[];
  scrollRef: RefObject<HTMLDivElement>;
  onPause?: (key?: string) => void;
  loadAll: () => void;
  hasMore: boolean;
  loading: boolean;
}) {
  const { t } = useTranslation('chat');
  const turns = useMemo(() => buildConversationTurns(messages), [messages]);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [railTop, setRailTop] = useState(0);
  const [railHeight, setRailHeight] = useState(320);
  const [pending, setPending] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLElement>(null);
  const pointerInside = useRef(false);
  const previewId = useId();
  const anchors = useMemo(() => new Map(items.filter(item => item.message.type === 'user')
    .map(item => [getIntrinsicMessageKey(item.message), item])), [items]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    let raf: number | null = null;
    const update = () => {
      raf = null;
      const edge = node.getBoundingClientRect().top + 64;
      const positions = new Map(Array.from(node.querySelectorAll<HTMLElement>('.chat-message[data-message-key]'))
        .map(row => [row.dataset.messageKey, row.getBoundingClientRect().top]));
      let current = 0;
      const offsets = [0];
      for (const height of heights) offsets.push(offsets[offsets.length - 1] + height);
      turns.forEach((turn, index) => {
        const item = anchors.get(turn.key);
        if (!item) return;
        const top = positions.get(item.itemKey);
        if (top !== undefined ? top <= edge : offsets[item.renderIndex] <= node.scrollTop + 24) current = index;
      });
      setActive(current);
    };
    const schedule = () => { if (raf === null) raf = requestAnimationFrame(update); };
    node.addEventListener('scroll', schedule, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(node);
    schedule();
    return () => { node.removeEventListener('scroll', schedule); observer?.disconnect(); if (raf !== null) cancelAnimationFrame(raf); };
  }, [turns, anchors, heights, scrollRef]);

  useLayoutEffect(() => {
    const node = rail.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setRailHeight(node.clientHeight));
    observer.observe(node);
    setRailHeight(node.clientHeight);
    return () => observer.disconnect();
  }, [turns.length]);

  useEffect(() => {
    const node = rail.current;
    if (!node || pointerInside.current || frame.current?.contains(document.activeElement)) return;
    const center = active * PITCH + 6;
    if (center < node.scrollTop + 20 || center > node.scrollTop + node.clientHeight - 20) {
      node.scrollTop = Math.max(0, center - node.clientHeight / 2);
    }
  }, [active, turns.length, railHeight]);

  useEffect(() => {
    if (!pending) return;
    const node = scrollRef.current;
    if (!node) return;
    let raf: number | null = null;
    let coarse = false;
    let cancelled = false;
    const cancel = () => { cancelled = true; setPending(null); };
    const keyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) cancel();
    };
    const observer = new MutationObserver(() => schedule());
    const land = () => {
      raf = null;
      if (cancelled) return;
      const item = anchors.get(pending);
      if (!item) return;
      const row = Array.from(node.querySelectorAll<HTMLElement>('.chat-message[data-message-key]'))
        .find(element => element.dataset.messageKey === item.itemKey);
      if (row) {
        const top = Math.max(0, node.scrollTop + row.getBoundingClientRect().top - node.getBoundingClientRect().top - 24);
        // Land before capturing the reading anchor. A native smooth scroll can
        // otherwise race the live transcript's resize/anchor corrections.
        if (typeof node.scrollTo === 'function') node.scrollTo({ top, behavior: 'auto' });
        else node.scrollTop = top;
        onPause?.(item.itemKey);
        setPending(null);
      } else if (!coarse) {
        coarse = true;
        scrollToMessageIndex(node, heights, item.renderIndex);
        schedule();
      }
    };
    const schedule = () => { if (raf === null) raf = requestAnimationFrame(land); };
    observer.observe(node, { childList: true, subtree: true });
    node.addEventListener('wheel', cancel, { passive: true });
    node.addEventListener('touchstart', cancel, { passive: true });
    node.addEventListener('pointerdown', cancel);
    node.addEventListener('keydown', keyDown);
    schedule();
    return () => { cancelled = true; observer.disconnect(); if (raf !== null) cancelAnimationFrame(raf);
      node.removeEventListener('wheel', cancel); node.removeEventListener('touchstart', cancel);
      node.removeEventListener('pointerdown', cancel); node.removeEventListener('keydown', keyDown); };
  }, [pending, anchors, heights, scrollRef, onPause]);

  const requestHistory = () => {
    setLoadError(false);
    const failed = () => { setLoadError(true); setPending(null); };
    try { void Promise.resolve(loadAll()).catch(failed); } catch { failed(); }
  };
  const navigate = (key: string) => {
    onPause?.();
    setLoadError(false);
    setPending(key);
    if (!anchors.has(key)) requestHistory();
  };
  const first = Math.max(0, Math.floor(railTop / PITCH) - 4);
  const last = Math.min(turns.length, Math.ceil((railTop + railHeight) / PITCH) + 4);
  const indices = Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i);
  if (focused !== null && focused < turns.length && !indices.includes(focused)) indices.push(focused);
  const selected = hovered ?? focused;
  const selectedTurn = selected === null ? null : turns[selected];

  if (turns.length < 2) return null;
  return <nav ref={frame} aria-label={t('turnNavigation.label')} className="conversation-turn-nav"
    style={{ height: Math.min(320, turns.length * PITCH + 12) }}
    onPointerEnter={() => { pointerInside.current = true; }}
    onPointerLeave={() => { pointerInside.current = false; setHovered(null); }}>
    {hasMore && <button type="button" className="conversation-turn-load" disabled={loading}
      aria-label={t('turnNavigation.loadEarlier')} onClick={() => { onPause?.(); requestHistory(); }}>
      <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
    </button>}
    <div ref={rail} className="conversation-turn-scroller" onScroll={event => setRailTop(event.currentTarget.scrollTop)}
      style={{ maskImage: railTop > 1 ? 'linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)' : undefined }}>
      <div className="relative" style={{ height: turns.length * PITCH + 12 }}>
        {indices.map(index => <button key={turns[index].key} type="button" className="conversation-turn-mark"
          style={{ top: index * PITCH + 6 }} data-turn-index={index}
          aria-label={t('turnNavigation.jump', { number: index + 1 })} aria-current={active === index ? 'true' : undefined}
          aria-busy={pending === turns[index].key ? 'true' : undefined}
          aria-describedby={selected === index ? previewId : undefined}
          tabIndex={index === (focused ?? active) ? 0 : -1}
          onPointerMove={() => setHovered(index)} onFocus={() => setFocused(index)} onBlur={() => setFocused(null)}
          onClick={() => navigate(turns[index].key)}
          onKeyDown={event => {
            if (event.key === 'Escape') { setHovered(null); setFocused(null); return; }
            const target = event.key === 'Home' ? 0 : event.key === 'End' ? turns.length - 1
              : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'ArrowDown' ? Math.min(turns.length - 1, index + 1) : null;
            if (target === null) return;
            event.preventDefault(); setFocused(target);
            if (rail.current) rail.current.scrollTop = Math.max(0, target * PITCH - railHeight / 2);
            requestAnimationFrame(() => frame.current?.querySelector<HTMLButtonElement>(`[data-turn-index="${target}"]`)?.focus({ preventScroll: true }));
          }} />)}
      </div>
    </div>
    {selectedTurn && <div id={previewId} role="tooltip" className="conversation-turn-preview"
      style={{ top: Math.max(0, Math.min((selected || 0) * PITCH + 6 - railTop - 48, railHeight - 110)) }}>
      <div className="truncate text-[13px] font-medium leading-5 text-foreground">{selectedTurn.prompt || t('turnNavigation.turn', { number: (selected || 0) + 1 })}</div>
      {selectedTurn.response && <div className="mt-1 line-clamp-3 text-[12px] leading-5 text-muted-foreground">{selectedTurn.response}</div>}
    </div>}
    {loadError && <span role="status" className="conversation-turn-preview text-[12px] text-muted-foreground">{t('session.loadFailedTitle')}</span>}
  </nav>;
}
