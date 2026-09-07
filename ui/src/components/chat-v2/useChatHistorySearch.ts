import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useRegisterFindShortcutTarget } from '../../contexts/FindShortcutContext';
import {
  buildSearchableMessages,
  clearSearchHighlights,
  findChatHistoryMatches,
  highlightSearchMatches,
  scrollSearchTargetIntoView,
  scrollToMessageIndex,
  type ChatHistorySearchMatch,
  type SearchableChatMessageInput,
} from './chatHistorySearchUtils';

type UseChatHistorySearchOptions = {
  scrollContainerRef: RefObject<HTMLElement | null>;
  keyedMessages: SearchableChatMessageInput[];
  measuredItemHeights: number[];
  allMessagesLoaded: boolean;
  hasMoreMessages: boolean;
  loadAllMessages: () => void | Promise<void>;
  sessionId: string | null;
  captureFindShortcutInModal?: boolean;
  renderWindowKey?: string | number;
  onNavigate?: () => void;
};

export function useChatHistorySearch({
  scrollContainerRef,
  keyedMessages,
  measuredItemHeights,
  allMessagesLoaded,
  hasMoreMessages,
  loadAllMessages,
  sessionId,
  captureFindShortcutInModal = false,
  renderWindowKey = 0,
  onNavigate,
}: UseChatHistorySearchOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigationRef = useRef(0);
  const requestedMatchRef = useRef<string | null>(null);
  const pendingRevealRef = useRef<{ match: ChatHistorySearchMatch; navigation: number; ready: boolean; coarseJumped: boolean } | null>(null);
  const refreshHighlightsRef = useRef<() => void>(() => {});

  const searchableMessages = useMemo(
    () => buildSearchableMessages(keyedMessages),
    [keyedMessages],
  );

  const matches = useMemo(
    () => findChatHistoryMatches(searchableMessages, query),
    [query, searchableMessages],
  );

  const activeMatch: ChatHistorySearchMatch | null = matches[activeMatchIndex] ?? null;

  const closeSearch = useCallback(() => {
    navigationRef.current += 1;
    requestedMatchRef.current = null;
    pendingRevealRef.current = null;
    setIsOpen(false);
    setQuery('');
    setActiveMatchIndex(0);
    const container = scrollContainerRef.current;
    if (container) clearSearchHighlights(container);
  }, [scrollContainerRef]);

  const openSearch = useCallback(() => {
    setIsOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const ensureAllMessagesLoaded = useCallback(async () => {
    if (!hasMoreMessages || allMessagesLoaded) return;
    await loadAllMessages();
  }, [allMessagesLoaded, hasMoreMessages, loadAllMessages]);

  const applySearchHighlights = useCallback((match: ChatHistorySearchMatch | null) => {
    const container = scrollContainerRef.current;
    if (!container) return null;
    return highlightSearchMatches(
      container,
      searchableMessages,
      matches,
      query.trim(),
      match,
    );
  }, [matches, query, scrollContainerRef, searchableMessages]);

  const revealMatch = useCallback(async (match: ChatHistorySearchMatch) => {
    const navigation = ++navigationRef.current;
    const pending = { match, navigation, ready: false, coarseJumped: false };
    pendingRevealRef.current = pending;
    onNavigate?.();
    try {
      await ensureAllMessagesLoaded();
    } catch {
      // Results already loaded remain searchable if fetching older history fails.
    }
    if (navigation !== navigationRef.current) return;
    pending.ready = true;
    refreshHighlightsRef.current();
  }, [ensureAllMessagesLoaded, onNavigate]);

  const goToMatch = useCallback((index: number) => {
    if (matches.length === 0) return;
    const wrapped = ((index % matches.length) + matches.length) % matches.length;
    setActiveMatchIndex(wrapped);
  }, [matches.length]);

  const goToNext = useCallback(() => {
    goToMatch(activeMatchIndex + 1);
  }, [activeMatchIndex, goToMatch]);

  const goToPrevious = useCallback(() => {
    goToMatch(activeMatchIndex - 1);
  }, [activeMatchIndex, goToMatch]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [query]);

  useEffect(() => {
    closeSearch();
  }, [closeSearch, sessionId]);

  const openFromShortcut = useCallback(() => {
    if (isOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    openSearch();
  }, [isOpen, openSearch]);

  useRegisterFindShortcutTarget({
    scope: 'chat',
    containerRef: scrollContainerRef,
    onOpen: openFromShortcut,
    captureInModal: captureFindShortcutInModal,
  });

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!isOpen || !activeMatch || !query.trim()) {
      if (container) clearSearchHighlights(container);
      requestedMatchRef.current = null;
      pendingRevealRef.current = null;
      return;
    }
    const key = `${sessionId}:${query}:${activeMatch.messageKey}:${activeMatch.offset}`;
    if (requestedMatchRef.current === key) return;
    requestedMatchRef.current = key;
    void revealMatch(activeMatch);
  }, [activeMatch, isOpen, query, revealMatch, scrollContainerRef, sessionId]);

  // The search index sees complete text before the typewriter exposes it. Wait
  // for a mark or for the row to finish rendering: cross-node phrases and hidden
  // link URLs may never produce a mark. Disconnect while marking our DOM changes.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isOpen || !query.trim()) return;
    let frame: number | null = null;
    const observer = new MutationObserver(() => schedule());
    const observe = () => observer.observe(container, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ['data-chat-search-render-pending'],
    });
    const refresh = () => {
      frame = null;
      observer.disconnect();
      const target = applySearchHighlights(activeMatch);
      observe();
      const pending = pendingRevealRef.current;
      if (!pending?.ready || pending.navigation !== navigationRef.current) return;
      const canReveal = target && (target.matches('mark[aria-current="true"]')
        || !target.querySelector('[data-chat-search-render-pending="true"]'));
      if (canReveal) {
        scrollSearchTargetIntoView(container, target, pending.coarseJumped ? 'auto' : 'smooth');
        onNavigate?.();
        pendingRevealRef.current = null;
      } else if (!target && !pending.coarseJumped) {
        // Only a missing row needs a virtualization jump. A mounted row may
        // still be draining text; keep waiting without moving the reader again.
        pending.coarseJumped = true;
        const match = matches.find((candidate) => candidate.messageKey === pending.match.messageKey
          && candidate.offset === pending.match.offset) ?? pending.match;
        scrollToMessageIndex(container, measuredItemHeights, match.messageIndex);
        schedule();
      }
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(refresh);
    };
    refreshHighlightsRef.current = schedule;
    observe();
    schedule();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      refreshHighlightsRef.current = () => {};
    };
  }, [activeMatch, applySearchHighlights, isOpen, query, renderWindowKey, matches, measuredItemHeights, onNavigate, scrollContainerRef]);

  useEffect(() => {
    if (matches.length === 0) {
      setActiveMatchIndex(0);
      return;
    }
    if (activeMatchIndex >= matches.length) {
      setActiveMatchIndex(0);
    }
  }, [activeMatchIndex, matches.length]);

  useEffect(() => {
    if (!isOpen) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const cancelNavigation = () => {
      navigationRef.current += 1;
      pendingRevealRef.current = null;
    };
    const cancelKeyboardNavigation = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelNavigation();
    };
    container.addEventListener('wheel', cancelNavigation, { passive: true });
    container.addEventListener('touchmove', cancelNavigation, { passive: true });
    container.addEventListener('keydown', cancelKeyboardNavigation);
    container.addEventListener('pointerdown', cancelNavigation);
    return () => {
      navigationRef.current += 1;
      container.removeEventListener('wheel', cancelNavigation);
      container.removeEventListener('touchmove', cancelNavigation);
      container.removeEventListener('keydown', cancelKeyboardNavigation);
      container.removeEventListener('pointerdown', cancelNavigation);
      clearSearchHighlights(container);
    };
  }, [isOpen, scrollContainerRef]);

  return {
    isOpen,
    query,
    setQuery,
    matches,
    activeMatchIndex,
    inputRef,
    openSearch,
    closeSearch,
    goToNext,
    goToPrevious,
  };
}
