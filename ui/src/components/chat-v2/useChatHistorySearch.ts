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
  const lastRevealedRef = useRef<string | null>(null);

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
    lastRevealedRef.current = null;
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

  const navigationDataRef = useRef({ applySearchHighlights, measuredItemHeights, matches });
  navigationDataRef.current = { applySearchHighlights, measuredItemHeights, matches };

  const revealMatch = useCallback(async (match: ChatHistorySearchMatch) => {
    const navigation = ++navigationRef.current;
    onNavigate?.();
    await ensureAllMessagesLoaded();
    if (navigation !== navigationRef.current) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const revealRenderedMatch = (behavior: ScrollBehavior): boolean => {
      const target = navigationDataRef.current.applySearchHighlights(match);
      if (!target) return false;
      scrollSearchTargetIntoView(container, target, behavior);
      onNavigate?.();
      return true;
    };

    // Nearby results are normally still mounted by the virtualized list. In
    // that case, move directly from the current viewport instead of first
    // resetting scrollTop from the beginning of the conversation.
    if (revealRenderedMatch('smooth')) return;

    // A distant result may not exist in the DOM yet. Perform one instant
    // coarse jump so virtualization can mount it, then center it without a
    // second long animation.
    const currentMatch = navigationDataRef.current.matches.find((candidate) =>
      candidate.messageKey === match.messageKey && candidate.offset === match.offset) ?? match;
    scrollToMessageIndex(container, navigationDataRef.current.measuredItemHeights, currentMatch.messageIndex);

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });

    if (navigation === navigationRef.current) revealRenderedMatch('auto');
  }, [
    ensureAllMessagesLoaded,
    onNavigate,
    scrollContainerRef,
  ]);

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
      lastRevealedRef.current = null;
      return;
    }
    const key = `${sessionId}:${query}:${activeMatch.messageKey}:${activeMatch.offset}`;
    if (lastRevealedRef.current === key) return;
    lastRevealedRef.current = key;
    void revealMatch(activeMatch);
  }, [activeMatch, isOpen, query, revealMatch, scrollContainerRef, sessionId]);

  useEffect(() => {
    if (!isOpen || !query.trim()) return undefined;
    const frame = requestAnimationFrame(() => {
      applySearchHighlights(activeMatch);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeMatch, applySearchHighlights, isOpen, query, renderWindowKey]);

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
    const cancelNavigation = () => { navigationRef.current += 1; };
    container.addEventListener('wheel', cancelNavigation, { passive: true });
    container.addEventListener('touchmove', cancelNavigation, { passive: true });
    return () => {
      navigationRef.current += 1;
      container.removeEventListener('wheel', cancelNavigation);
      container.removeEventListener('touchmove', cancelNavigation);
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
