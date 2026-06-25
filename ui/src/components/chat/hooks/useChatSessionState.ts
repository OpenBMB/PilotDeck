import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import type { ChatMessage, ClaudeWorkStatus, PilotDeckWorkStatus } from '../types/types';
import {
  getSessionRequestParams,
  isBackgroundTaskSession,
  type Project,
  type ProjectSession,
  type SessionProvider,
} from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import { parseUserAttachmentNote } from '../utils/attachmentNotes';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import { normalizedToChatMessages } from './useChatMessages';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 100;
const EMPTY_NORMALIZED_MESSAGES: NormalizedMessage[] = [];
export const BOTTOM_FOLLOW_THRESHOLD_PX = 96;

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  autoScrollToBottom?: boolean;
  externalMessageUpdate?: number;
  processingSessions?: Set<string>;
  resetStreamingState: () => void;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  sessionStore: SessionStore;
}

interface ScrollRestoreState {
  height: number;
  top: number;
}

export function isScrollNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx = BOTTOM_FOLLOW_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < thresholdPx;
}

/**
 * Whether the session-loading effect is entering a different session than
 * the one it last loaded for. Lives next to `lastLoadedSessionKeyRef` because
 * it must NOT consult `currentSessionId` — that piece of React state is
 * eagerly mirrored to `selectedSession.id` during render to keep the OLD
 * session's messages from bleeding into a freshly-cleared view, which means
 * by the time effects run it is already equal to `selectedSession.id`.
 * Using it for change-detection would always evaluate to false on a real
 * `tokenBudget` from the previous session into the new view.
 */
export function didLoadedSessionChange(
  lastLoadedSessionKey: string | null,
  incomingSessionKey: string,
): boolean {
  return lastLoadedSessionKey !== null && lastLoadedSessionKey !== incomingSessionKey;
}

/**
 * Whether the optimistic "pending user message" bubble should render in the
 * currently active view. The pending bubble is hook-wide singleton state on
 * `ChatInterfaceV2`; without this gate, switching sessions while it's queued
 * would prepend the optimistic text onto the WRONG session's transcript —
 * surfaced as "the latest query I just typed appears at the top of an
 * unrelated session I just opened".
 *
 * It belongs here iff:
 *   1. We are still on the welcome surface (no active session yet) — the
 *      pending bubble is the only thing the user can see.
 *   2. The active session id matches the session id `pendingViewSessionRef`
 *      was bound to at submit time (stamped by `session_created`).
 */
export function shouldRenderPendingBubble(
  activeSessionId: string | null,
  pendingTargetSessionId: string | null,
): boolean {
  if (!activeSessionId) return true;
  return pendingTargetSessionId !== null && pendingTargetSessionId === activeSessionId;
}

export function getStreamContentKey(messages: ChatMessage[]): string {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    return 'empty';
  }

  const contentLength = typeof lastMessage.content === 'string' ? lastMessage.content.length : 0;
  const toolContent = lastMessage.toolResult?.content;
  const toolContentLength = typeof toolContent === 'string' ? toolContent.length : 0;
  return [
    lastMessage.id || '',
    lastMessage.type || '',
    lastMessage.isStreaming ? 'streaming' : '',
    contentLength,
    toolContentLength,
    messages.length,
  ].join(':');
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: SessionProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  // Carry user-attached image data URLs through the normalize round-trip
  // so the optimistic message render and any re-derivation from the
  // session store both show the thumbnails. NormalizedMessage.images is
  // `string[]` of data URLs; we only attach it on user-side text frames.
  const images = msg.type === 'user' && Array.isArray(msg.images)
    ? msg.images
        .filter((img) => img && typeof img.data === 'string')
        .map((img) => img.data)
    : undefined;
  const attachments = msg.type === 'user' && Array.isArray(msg.attachments)
    ? msg.attachments.filter((attachment) => attachment && typeof attachment.name === 'string')
    : undefined;
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    ...(images && images.length > 0 ? { images } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  } as NormalizedMessage;
}

function normalizeUserMessageText(value: unknown): string {
  const parsed = parseUserAttachmentNote(value);
  return parsed.content.replace(/\s+/g, ' ').trim();
}

function getUserAttachmentNames(message: ChatMessage): string[] {
  const explicitNames = Array.isArray(message.attachments)
    ? message.attachments.map((attachment) => attachment.name || '').filter(Boolean)
    : [];
  const parsedNames = parseUserAttachmentNote(message.content).attachments
    .map((attachment) => attachment.name || '')
    .filter(Boolean);
  return [...explicitNames, ...parsedNames].sort();
}

function hasEquivalentUserMessage(messages: ChatMessage[], pendingUserMessage: ChatMessage): boolean {
  const pendingText = normalizeUserMessageText(pendingUserMessage.content);
  const pendingImageCount = Array.isArray(pendingUserMessage.images) ? pendingUserMessage.images.length : 0;
  const pendingAttachmentNames = getUserAttachmentNames(pendingUserMessage);

  return messages.some((message) => {
    if (message.type !== 'user') return false;
    if (normalizeUserMessageText(message.content) !== pendingText) return false;

    const imageCount = Array.isArray(message.images) ? message.images.length : 0;
    if (imageCount !== pendingImageCount) return false;

    const attachmentNames = getUserAttachmentNames(message);
    return attachmentNames.join('\n') === pendingAttachmentNames.join('\n');
  });
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  autoScrollToBottom,
  externalMessageUpdate,
  processingSessions,
  resetStreamingState,
  pendingViewSessionRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [canAbortSession, setCanAbortSession] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeWorkStatus | null>(null);
  const [pilotDeckStatus, setPilotDeckStatus] = useState<PilotDeckWorkStatus | null>(null);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  const followScrollFrameRef = useRef<number | null>(null);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => () => {
    if (followScrollFrameRef.current !== null) {
      cancelAnimationFrame(followScrollFrameRef.current);
      followScrollFrameRef.current = null;
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */

  // Bug fix (was: `selectedSession?.id || currentSessionId || null`): when the
  // user clicks "+ session" the parent flips `selectedSession` to null, but
  // `currentSessionId` still holds the previous session's id for one render
  // tick — so storeMessages would briefly read the OLD session's messages
  // and bleed them into the freshly-cleared chat view.
  //
  // Strategy:
  //   1. Mirror `selectedSession.id` into `currentSessionId` during render
  //      whenever the selection changes — drops any stale carryover.
  //   2. Expose an `effectiveCurrentSessionId` ref so the *current* render
  //      uses the cleared value, not the lagging React state.
  //   3. While the selection is stable but `currentSessionId` advances
  //      (e.g. backend emits `session_created` for a from-welcome submit
  //      before the parent navigates), keep mirroring forward so the new
  //      id is visible immediately.
  const selSid = selectedSession?.id ?? null;
  const lastSeenSelSidRef = useRef<string | null>(selSid);
  const effectiveCurrentRef = useRef<string | null>(selSid);
  if (lastSeenSelSidRef.current !== selSid) {
    lastSeenSelSidRef.current = selSid;
    effectiveCurrentRef.current = selSid;
    if (currentSessionId !== selSid) {
      setCurrentSessionId(selSid);
    }
  } else if (currentSessionId !== effectiveCurrentRef.current) {
    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const isPendingSessionHandoff =
      Boolean(currentSessionId) && pendingSessionId === currentSessionId;
    if (selSid) {
      effectiveCurrentRef.current = selSid;
      if (currentSessionId !== selSid) {
        setCurrentSessionId(selSid);
      }
    } else if (isPendingSessionHandoff) {
      effectiveCurrentRef.current = currentSessionId;
    } else {
      effectiveCurrentRef.current = null;
      if (currentSessionId !== null) {
        setCurrentSessionId(null);
      }
    }
  }
  const pendingSessionIdForRender = pendingViewSessionRef.current?.sessionId ?? null;
  // No selectedSession means we are intentionally on a fresh chat surface unless
  // the backend is still handing us the real id for the first message.
  const hasStaleUnselectedCurrentSession =
    Boolean(currentSessionId) && !selSid && pendingSessionIdForRender !== currentSessionId;
  if (hasStaleUnselectedCurrentSession) {
    effectiveCurrentRef.current = null;
    setCurrentSessionId(null);
  }

  const activeSessionId = selSid ?? effectiveCurrentRef.current;
  const isReadOnlyBackgroundSession = isBackgroundTaskSession(selectedSession);
  const sessionRequestParams = useMemo(
    () => getSessionRequestParams(selectedSession),
    [selectedSession],
  );
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);

  // Tell the store which session we're viewing so it only re-renders for this one
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionId !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionId;
    sessionStore.setActiveSession(activeSessionId);
  }

  // When a real session ID arrives and we have a pending user message, flush
  // it to the store. The flush MUST be gated on `pendingViewSessionRef`: that
  // ref is what the composer + the session_created handler use to record the
  // sessionId that this pending message was actually queued for. Without that
  // gate, a user who types in welcome mode and then clicks an existing
  // session in the sidebar before session_created arrives would have their
  // pending text leaked into the unrelated session's realtime slot — and
  // because realtime slots are not cleared on session switch, that ghost
  // message would re-appear on every subsequent reopen.
  const prevActiveSessionRef = useRef<string | null>(null);
  if (activeSessionId && activeSessionId !== prevActiveSessionRef.current && pendingUserMessage) {
    const expectedSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    if (expectedSessionId && activeSessionId === expectedSessionId) {
      const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, 'pilotdeck' as SessionProvider);
      if (normalized) {
        sessionStore.appendRealtime(activeSessionId, normalized);
      }
    }
    setPendingUserMessage(null);
  }
  prevActiveSessionRef.current = activeSessionId;

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : EMPTY_NORMALIZED_MESSAGES;
  const activityStoreMessages = activeSessionId
    ? sessionStore.getActivityMessages?.(activeSessionId) ?? []
    : [];
  const subagentLinks = activeSessionId
    ? sessionStore.getSessionSlot?.(activeSessionId)?.subagentLinks
    : undefined;

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  // `pendingViewSessionRef.current.sessionId` is the session the optimistic
  // bubble was actually queued for. session_created stamps it. We read it
  // here AND list it as a memo dep (via `pendingTargetSessionId`) so the
  // memo recomputes when session_created upgrades the ref from null → real id.
  const pendingTargetSessionId = pendingViewSessionRef.current?.sessionId ?? null;

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages, subagentLinks);
    // The optimistic user bubble must ONLY render in the session it was
    // submitted into. Two valid surfaces:
    //   1. The welcome surface itself (activeSessionId=null), while we are
    //      still waiting for `session_created` to tell us the real id.
    //   2. The exact session id that `pendingViewSessionRef` was bound to
    //      at submit time.
    // Without this gate, a sidebar click after a welcome submit (or any
    // session switch while the bubble is queued) would prepend the
    // optimistic text onto the WRONG session's transcript — surfaced as
    // "the latest query I just typed appears at the top of an unrelated
    // session I just opened". The handoff block above eventually pushes
    // the bubble into the right store + clears it, but React's discard-
    // and-rerender on render-phase setState isn't a guarantee under
    // concurrent rendering / batched parent updates, so we also defend
    // here at the read site.
    const pendingBelongsHere = shouldRenderPendingBubble(activeSessionId, pendingTargetSessionId);
    if (
      pendingUserMessage &&
      pendingBelongsHere &&
      !hasEquivalentUserMessage(all, pendingUserMessage)
    ) {
      return [pendingUserMessage, ...all];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [storeMessages, viewHiddenCount, pendingUserMessage, activeSessionId, pendingTargetSessionId, subagentLinks]);

  const activityMessages = normalizedToChatMessages(activityStoreMessages);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage, targetSessionId?: string | null) => {
    const sessionId = targetSessionId !== undefined ? targetSessionId : activeSessionId;
    if (!sessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const normalized = chatMessageToNormalized(msg, sessionId, 'pilotdeck' as SessionProvider);
    if (normalized) {
      sessionStore.appendRealtime(sessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    if (followScrollFrameRef.current !== null) {
      return;
    }
    followScrollFrameRef.current = requestAnimationFrame(() => {
      followScrollFrameRef.current = null;
      scrollToBottom();
    });
  }, [scrollToBottom]);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return isScrollNearBottom(scrollTop, scrollHeight, clientHeight);
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;
      const previousScrollHeight = container.scrollHeight;
      const previousScrollTop = container.scrollTop;

      try {
        const slot = await sessionStore.fetchMore(selectedSession.id, {
          provider: 'pilotdeck',
          projectName: selectedProject.name,
          projectPath: selectedProject.fullPath || selectedProject.path || '',
          ...sessionRequestParams,
          limit: MESSAGES_PER_PAGE,
        });
        if (!slot || slot.serverMessages.length === 0) return false;

        pendingScrollRestoreRef.current = { height: previousScrollHeight, top: previousScrollTop };
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        setVisibleMessageCount((prev) => prev + MESSAGES_PER_PAGE);
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [
      hasMoreMessages,
      isLoadingMoreMessages,
      selectedProject,
      selectedSession,
      sessionRequestParams,
      sessionStore,
    ],
  );

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);

    if (!allMessagesLoadedRef.current) {
      const scrolledNearTop = container.scrollTop < 100;
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [isNearBottom, loadOlderMessages]);

  useLayoutEffect(() => {
    if (!pendingScrollRestoreRef.current || !scrollContainerRef.current) return;
    const { height, top } = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = top + Math.max(newScrollHeight - height, 0);
    pendingScrollRestoreRef.current = null;
  }, [chatMessages.length]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      pendingInitialScrollRef.current = true;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    setIsUserScrolledUp(false);
  }, [selectedProject?.name, selectedSession?.id]);

  // Initial scroll to bottom
  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    pendingInitialScrollRef.current = false;
    if (!searchScrollActiveRef.current) setTimeout(() => scrollToBottom(), 200);
  }, [chatMessages.length, isLoadingSessionMessages, scrollToBottom]);

  // Main session loading effect — store-based
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // Guard: skip the full reset while a new-session handoff is in
      // flight. Two distinct transient windows must be protected:
      //
      // 1. session_created already arrived → currentSessionId is set and
      //    matches the pendingViewSession, but selectedSession hasn't
      //    resolved yet (projects list refresh still in progress).
      //
      // 2. The user just submitted from the welcome surface and we're
      //    still waiting for session_created. pendingViewSessionRef has
      //    been allocated (with sessionId: null) but the backend hasn't
      //    responded yet. A projects_updated WS message can change
      //    selectedProject's reference and re-fire this effect — the
      //    reset would wipe pendingUserMessage and flash back to welcome.
      const isPendingSessionHandoff =
        Boolean(currentSessionId) &&
        pendingViewSessionRef.current?.sessionId === currentSessionId;
      const isAwaitingSessionCreation =
        pendingViewSessionRef.current !== null &&
        !pendingViewSessionRef.current.sessionId;
      if (!selectedSession && (isPendingSessionHandoff || isAwaitingSessionCreation)) {
        return;
      }
      resetStreamingState();
      pendingViewSessionRef.current = null;
      setPendingUserMessage(null);
      setClaudeStatus(null);
      setPilotDeckStatus(null);
      setCanAbortSession(false);
      setIsAborting(false);
      setIsLoading(false);
      setSessionLoadError(null);
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    const provider = 'pilotdeck';
    const sessionKey = `${selectedSession.id}:${selectedProject.name}:${provider}`;

    // Skip if already loaded and fresh, or if stale but has live realtime
    // content (re-fetching while streaming would prune in-flight messages).
    if (lastLoadedSessionKeyRef.current === sessionKey && sessionStore.has(selectedSession.id)) {
      const hasRealtimeContent = (sessionStore.getSessionSlot?.(selectedSession.id)?.realtimeMessages?.length ?? 0) > 0;
      if (!sessionStore.isStale(selectedSession.id) || hasRealtimeContent) {
        return;
      }
    }

    // See `didLoadedSessionChange` for why we don't compare `currentSessionId`
    // against `selectedSession.id` here (the render-phase mirror nullifies
    // that check on real session-to-session switches).
    const sessionChanged = didLoadedSessionChange(lastLoadedSessionKeyRef.current, sessionKey);
    if (sessionChanged) {
      resetStreamingState();
      pendingViewSessionRef.current = null;
      setClaudeStatus(null);
      setPilotDeckStatus(null);
      setSessionLoadError(null);
      setCanAbortSession(false);
      setIsAborting(false);
    }

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
      setIsLoading(false);
    }

    setCurrentSessionId(selectedSession.id);
    setSessionLoadError(null);

    // Check session status
    if (ws && !isReadOnlyBackgroundSession) {
      sendMessage({ type: 'check-session-status', sessionId: selectedSession.id, provider });
    }

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    // Intentionally fetch the WHOLE transcript on session entry: PilotDeck's
    // `readSessionMessages` slices in jsonl-forward order (`allMessages.slice(
    // offset, offset+limit)`), but the ui-side `fetchMore` path that handles
    // scroll-to-top assumes "more older messages" semantics and prepends the
    // returned batch to serverMessages. The two are incompatible, so paging
    // here produces a reordered transcript (the second-page batch — actually
    // the *newer* tail messages — gets prepended in front of the older ones
    // already on screen). Sessions are typically well under a few hundred
    // messages, so fetching everything is fine.
    sessionStore.fetchFromServer(selectedSession.id, {
      provider: 'pilotdeck',
      projectName: selectedProject.name,
      projectPath: selectedProject.fullPath || selectedProject.path || '',
      ...sessionRequestParams,
      limit: null,
      offset: 0,
    }).then(slot => {
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
        setSessionLoadError(slot.status === 'error'
          ? slot.lastError || 'Unable to load conversation messages.'
          : null);
      }
      setIsLoadingSessionMessages(false);
    }).catch((error) => {
      setSessionLoadError(error instanceof Error ? error.message : 'Unable to load conversation messages.');
      setIsLoadingSessionMessages(false);
    });
  }, [
    currentSessionId,
    pendingViewSessionRef,
    resetStreamingState,
    selectedProject,
    selectedSession,
    sendMessage,
    ws,
    isReadOnlyBackgroundSession,
    sessionRequestParams,
    sessionStore,
  ]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isLoading) {
          await sessionStore.refreshFromServer(selectedSession.id, {
            provider: 'pilotdeck',
            projectName: selectedProject.name,
            projectPath: selectedProject.fullPath || selectedProject.path || '',
            ...sessionRequestParams,
          });

          if (Boolean(autoScrollToBottom) && isNearBottom()) {
            setTimeout(() => scrollToBottom(), 200);
          }
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    autoScrollToBottom,
    externalMessageUpdate,
    isNearBottom,
    scrollToBottom,
    selectedProject,
    selectedSession,
    sessionRequestParams,
    sessionStore,
    isLoading,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  useEffect(() => {
    if (selectedSession?.id) pendingViewSessionRef.current = null;
  }, [pendingViewSessionRef, selectedSession?.id]);

  // Scroll to search target
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);
    let cancelled = false;

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
        {
          try {
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              provider: 'pilotdeck',
              projectName: selectedProject.name,
              projectPath: selectedProject.fullPath || selectedProject.path || '',
              ...sessionRequestParams,
              limit: null,
              offset: 0,
            });
            if (cancelled) return;
            if (slot) {
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.total;
              setVisibleMessageCount(Infinity);
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              await new Promise(resolve => setTimeout(resolve, 300));
              if (cancelled) return;
            }
          } catch {
            // Fall through and scroll in current messages
          }
        }
      }
      setVisibleMessageCount(Infinity);

      const findAndScroll = (retriesLeft: number) => {
        if (cancelled) return;
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) { targetElement = el; break; }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) { closestDiff = diff; targetElement = el; }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => {
            if (!cancelled) targetElement?.classList.remove('search-highlight-flash');
          }, 4000);
          searchScrollActiveRef.current = false;
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
        }
      };

      setTimeout(() => findAndScroll(15), 150);
    };

    scrollToTarget();
    return () => { cancelled = true; };
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget, selectedProject, selectedSession, sessionRequestParams, sessionStore]);

  useEffect(() => {
    if (!selectedProject || !selectedSession?.id || selectedSession.id.startsWith('new-session-')) {
      setTokenBudget(null);
      return;
    }
    if (isReadOnlyBackgroundSession) {
      setTokenBudget(null);
      return;
    }

    const fetchInitialTokenUsage = async () => {
      try {
        const url = `/api/projects/${selectedProject.name}/sessions/${encodeURIComponent(selectedSession.id)}/token-usage?provider=pilotdeck`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          setTokenBudget(await response.json());
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [isReadOnlyBackgroundSession, selectedProject, selectedSession?.id]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);
  const streamContentKey = useMemo(
    () => getStreamContentKey(visibleMessages),
    [visibleMessages],
  );

  useEffect(() => {
    if (!autoScrollToBottom && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      scrollPositionRef.current = { height: container.scrollHeight, top: container.scrollTop };
    }
  });

  useEffect(() => {
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) return;
    if (searchScrollActiveRef.current) return;

    if (autoScrollToBottom) {
      if (!isUserScrolledUp) scheduleScrollToBottom();
      return;
    }

    const container = scrollContainerRef.current;
    const prevHeight = scrollPositionRef.current.height;
    const prevTop = scrollPositionRef.current.top;
    const newHeight = container.scrollHeight;
    const heightDiff = newHeight - prevHeight;
    if (heightDiff > 0 && prevTop > 0) container.scrollTop = prevTop + heightDiff;
  }, [
    autoScrollToBottom,
    chatMessages.length,
    isLoadingMoreMessages,
    isUserScrolledUp,
    scheduleScrollToBottom,
    streamContentKey,
  ]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const activeViewSessionId =
      selectedSession?.id || (pendingSessionId === currentSessionId ? currentSessionId : null);
    if (!activeViewSessionId || !processingSessions) return;
    const shouldBeProcessing = processingSessions.has(activeViewSessionId);
    if (shouldBeProcessing && !isLoading) {
      setIsLoading(true);
      setCanAbortSession(true);
    }
  }, [currentSessionId, isLoading, pendingViewSessionRef, processingSessions, selectedSession?.id]);

  // "Load all" overlay
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoadingMoreMessages;

    if (wasLoading && !isLoadingMoreMessages && hasMoreMessages) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(true);
      loadAllOverlayTimerRef.current = setTimeout(() => setShowLoadAllOverlay(false), 2000);
    }
    if (!hasMoreMessages && !isLoadingMoreMessages) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(false);
    }
    return () => { if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current); };
  }, [isLoadingMoreMessages, hasMoreMessages]);

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);

    const container = scrollContainerRef.current;
    const previousScrollHeight = container ? container.scrollHeight : 0;
    const previousScrollTop = container ? container.scrollTop : 0;

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        provider: 'pilotdeck',
        projectName: selectedProject.name,
        projectPath: selectedProject.fullPath || selectedProject.path || '',
        ...sessionRequestParams,
        limit: null,
        offset: 0,
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        if (container) {
          pendingScrollRestoreRef.current = { height: previousScrollHeight, top: previousScrollTop };
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.total;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => { setLoadAllJustFinished(false); setShowLoadAllOverlay(false); }, 1000);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [
    selectedSession,
    selectedProject,
    isLoadingAllMessages,
    currentSessionId,
    sessionRequestParams,
    sessionStore,
  ]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  return {
    chatMessages,
    activityMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    sessionLoadError,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isAborting,
    setIsAborting,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    pilotDeckStatus,
    setPilotDeckStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
  };
}
