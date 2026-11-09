import { useVideoJobs } from "../tools/useVideoJobs";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import type {
  ChatMessage,
  ClaudeWorkStatus,
  PilotDeckWorkStatus,
  SessionRuntimeState,
} from '../types/types';
import {
  getSessionRequestParams,
  isReadOnlySession,
  type Project,
  type ProjectSession,
  type SessionProvider,
  type SessionMessagesUpdateTarget,
} from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import { parseUserAttachmentNote } from '../utils/attachmentNotes';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import {
  buildSessionStatusRequestIfIdle,
  invalidateSessionStatusResponses,
} from '../sessionStatusProtocol';
import { normalizedToChatMessages } from './useChatMessages';
import { useScrollFollow, type ReadingAnchor } from './useScrollFollow';
import { useSessionRequestScope, type HistoryRequestKind, type HistoryRequestResult } from './useSessionRequestScope';

const MESSAGES_PER_PAGE = 100;
const EMPTY_NORMALIZED_MESSAGES: NormalizedMessage[] = [];
export const BOTTOM_FOLLOW_THRESHOLD_PX = 96;

export function shouldFollowConversationScroll(
  autoScrollToBottom: boolean | undefined,
  isUserScrolledUp: boolean,
): boolean {
  return Boolean(autoScrollToBottom) && !isUserScrolledUp;
}

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
  externalMessageUpdateTarget?: SessionMessagesUpdateTarget | null;
  processingSessions?: Set<string>;
  resetStreamingState: () => void;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  sessionStore: SessionStore;
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
 * `ChatInterface`; without this gate, switching sessions while it's queued
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

export function chatMessageToNormalized(
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
  const base = {
    id,
    sessionId,
    timestamp: ts,
    provider,
    ...(msg.runId ? { runId: msg.runId } : {}),
    ...(msg.turnId ? { turnId: msg.turnId } : {}),
  };

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
    return {
      ...base,
      kind: 'error',
      content: msg.content || '',
      ...((msg as any).userHint ? { userHint: (msg as any).userHint } : {}),
    } as NormalizedMessage;
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

export function hasEquivalentUserMessage(messages: ChatMessage[], pendingUserMessage: ChatMessage): boolean {
  const pendingTurnId = pendingUserMessage.turnId || pendingUserMessage.runId;
  const pendingText = normalizeUserMessageText(pendingUserMessage.content);
  const pendingImageCount = Array.isArray(pendingUserMessage.images) ? pendingUserMessage.images.length : 0;
  const pendingAttachmentNames = getUserAttachmentNames(pendingUserMessage);

  return messages.some((message) => {
    if (message.type !== 'user') return false;
    const messageTurnId = message.turnId || message.runId;
    if (pendingTurnId || messageTurnId) {
      return Boolean(pendingTurnId && messageTurnId && pendingTurnId === messageTurnId);
    }
    if (normalizeUserMessageText(message.content) !== pendingText) return false;

    const imageCount = Array.isArray(message.images) ? message.images.length : 0;
    if (imageCount !== pendingImageCount) return false;

    const attachmentNames = getUserAttachmentNames(message);
    return attachmentNames.join('\n') === pendingAttachmentNames.join('\n');
  });
}

type ConversationScrollPosition = {
  top: number;
  distanceFromBottom: number;
  following?: boolean;
  anchor?: ReadingAnchor | null;
  historyStartId?: string;
};

const CONVERSATION_SCROLL_BOTTOM_THRESHOLD = 40;

export function resolveConversationScrollTop(
  position: ConversationScrollPosition,
  scrollHeight: number,
  clientHeight: number,
): number {
  const maximumScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (position.following ?? position.distanceFromBottom <= CONVERSATION_SCROLL_BOTTOM_THRESHOLD) {
    return maximumScrollTop;
  }
  return Math.min(Math.max(0, position.top), maximumScrollTop);
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
  externalMessageUpdateTarget,
  processingSessions,
  resetStreamingState,
  pendingViewSessionRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [isLoading, setIsLoadingState] = useState(false);
  const [sessionRuntimeState, setSessionRuntimeState] = useState<SessionRuntimeState>(() => (
    selectedSession && !isReadOnlySession(selectedSession) ? 'synchronizing' : 'inactive'
  ));
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const activeRunIdRef = useRef<string | null>(activeRunId);
  activeRunIdRef.current = activeRunId;
  const setIsLoading = useCallback((loading: boolean) => {
    setIsLoadingState(loading);
    if (loading) setSessionRuntimeState('running');
  }, []);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState(false);
  const [historyReadyScrollKey, setHistoryReadyScrollKey] = useState<string | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [canAbortSession, setCanAbortSession] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [tokenBudget, setTokenBudgetState] = useState<Record<string, unknown> | null>(null);
  const tokenBudgetRevision = useRef(0);
  const setTokenBudget = useCallback((budget: Record<string, unknown> | null) => {
    tokenBudgetRevision.current += 1;
    setTokenBudgetState(budget);
  }, []);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeWorkStatus | null>(null);
  const [pilotDeckStatus, setPilotDeckStatus] = useState<PilotDeckWorkStatus | null>(null);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const pendingInitialScrollRef = useRef(true);
  const historyReadyScrollKeyRef = useRef<string | null>(null);
  const conversationScrollPositionsRef = useRef(new Map<string, ConversationScrollPosition>());
  const pendingConversationScrollRestoreRef = useRef<{
    key: string;
    position: ConversationScrollPosition;
  } | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

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
  const requestScope = useSessionRequestScope(selectedProject, selectedSession);
  const activeScrollKey = requestScope?.key ?? (selectedProject && activeSessionId
    ? `${selectedProject.name}:${activeSessionId}` : null);
  const sessionIsReadOnly = isReadOnlySession(selectedSession);
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

  const baseChatMessages = useMemo(() => {
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

  const chatMessages = useVideoJobs(baseChatMessages);

  const activityMessages = useMemo(
    () => normalizedToChatMessages(activityStoreMessages),
    [activityStoreMessages],
  );

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

  const {
    isPaused: isUserScrolledUp,
    canReturnToLatest,
    setPaused: setIsUserScrolledUp,
    getIsPaused,
    pauseAt: pauseScrollFollowing,
    scrollToBottom,
    scheduleFollow: scheduleScrollToBottom,
    scheduleInitialPosition,
    captureAnchor: captureReadingAnchor,
    getReadingAnchor,
    restoreReadingAnchor,
  } = useScrollFollow({
    containerRef: scrollContainerRef,
    enabled: Boolean(autoScrollToBottom),
    scopeKey: activeScrollKey,
    contentKey: isLoadingSessionMessages || chatMessages.length === 0,
    initialPositionKey: chatMessages.length,
    contentSelector: '[data-chat-scroll-content]',
    canFollow: () => !searchScrollActiveRef.current && !isLoadingMoreRef.current && !isLoadingSessionMessages,
  });
  const activeScrollKeyRef = useRef(activeScrollKey);
  activeScrollKeyRef.current = activeScrollKey;

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return isScrollNearBottom(scrollTop, scrollHeight, clientHeight);
  }, []);

  const requestHistory = useCallback(async (
    kind: HistoryRequestKind,
    extraOptions: { includeFromId?: string; afterRestore?: boolean } = {},
  ): Promise<HistoryRequestResult> => {
    if (!requestScope) return { status: 'stale' };
    const isCurrent = requestScope.capture();
    const result = await requestScope.run(kind, () => {
      const options = { ...requestScope.options, ...extraOptions };
      if (kind === 'refresh') return sessionStore.refreshFromServer(requestScope.sessionId, options);
      if (kind === 'older') return sessionStore.fetchMore(requestScope.sessionId, { ...options, limit: MESSAGES_PER_PAGE });
      return sessionStore.fetchFromServer(requestScope.sessionId, {
        ...options, limit: kind === 'full' ? null : MESSAGES_PER_PAGE,
        ...(kind === 'full' ? { offset: 0 } : { direction: 'backward' as const }),
      });
    }, JSON.stringify(extraOptions));
    if (!isCurrent()) return { status: 'stale' };
    if (result.status === 'success') {
      setHasMoreMessages(result.slot.hasMore);
      setTotalMessages(result.slot.total);
      setAllMessagesLoaded(!result.slot.hasMore);
      allMessagesLoadedRef.current = !result.slot.hasMore;
      setSessionLoadError(null);
      setHistoryLoadError(false);
    } else if (result.status === 'error') {
      if (kind === 'initial') setSessionLoadError(result.error.message);
      else setHistoryLoadError(true);
    }
    return result;
  }, [requestScope, sessionStore]);

  const refreshSessionMessages = useCallback((options?: { afterRestore?: boolean }) => (
    requestHistory('refresh', options)
  ), [requestHistory]);

  const retrySessionMessages = useCallback(async () => {
    if (!requestScope) return;
    const isCurrent = requestScope.capture();
    setIsLoadingSessionMessages(true);
    setSessionLoadError(null);
    try {
      await requestHistory('initial');
      if (isCurrent()) {
        historyReadyScrollKeyRef.current = activeScrollKey;
        setHistoryReadyScrollKey(activeScrollKey);
      }
    } finally {
      if (isCurrent()) setIsLoadingSessionMessages(false);
    }
  }, [activeScrollKey, requestHistory, requestScope]);

  const loadAllMessages = useCallback(async () => {
    if (!requestScope) return;
    const isCurrent = requestScope.capture();
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    captureReadingAnchor();
    try {
      const result = await requestHistory('full');
      if (result.status === 'error') throw result.error;
      if (result.status === 'stale' && isCurrent() && !allMessagesLoadedRef.current) {
        // A newer partial refresh can supersede this response. Search must get
        // a retryable outcome instead of waiting forever for a complete history.
        setHistoryLoadError(true);
        throw new Error('Conversation changed while loading history. Please retry.');
      }
    } finally {
      if (isCurrent()) {
        isLoadingMoreRef.current = false;
        setIsLoadingAllMessages(false);
      }
    }
  }, [captureReadingAnchor, requestHistory, requestScope]);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !requestScope) return false;

      isLoadingMoreRef.current = true;
      setIsLoadingMoreMessages(true);
      const isCurrent = requestScope.capture();
      captureReadingAnchor();

      try {
        return (await requestHistory('older')).status === 'success';
      } finally {
        if (isCurrent()) {
          isLoadingMoreRef.current = false;
          setIsLoadingMoreMessages(false);
        }
      }
    },
    [
      captureReadingAnchor,
      hasMoreMessages,
      isLoadingMoreMessages,
      requestHistory,
      requestScope,
    ],
  );

  const handleScroll = useCallback(() => {
    const eventScope = activeScrollKey;
    // React's scroll handler can precede the shared native controller. Save
    // after it accepts the gesture, rather than caching its previous anchor.
    queueMicrotask(() => {
      const container = scrollContainerRef.current;
      if (!container || !eventScope || activeScrollKeyRef.current !== eventScope
        || historyReadyScrollKeyRef.current !== eventScope
        || pendingInitialScrollRef.current || pendingConversationScrollRestoreRef.current) return;
      conversationScrollPositionsRef.current.set(eventScope, {
        top: container.scrollTop,
        following: Boolean(autoScrollToBottom) && !getIsPaused(),
        anchor: getReadingAnchor(),
        historyStartId: activeSessionId ? sessionStore.getSessionSlot(activeSessionId)?.serverMessages[0]?.id : undefined,
        distanceFromBottom: Math.max(
          0,
          container.scrollHeight - container.scrollTop - container.clientHeight,
        ),
      });
    });
  }, [activeScrollKey, activeSessionId, autoScrollToBottom, getIsPaused, getReadingAnchor, sessionStore]);

  // Reset scroll/pagination state on session change
  useLayoutEffect(() => {
    historyReadyScrollKeyRef.current = null;
    setHistoryReadyScrollKey(null);
    const savedScrollPosition = activeScrollKey
      ? conversationScrollPositionsRef.current.get(activeScrollKey) ?? null
      : null;
    pendingConversationScrollRestoreRef.current = activeScrollKey && savedScrollPosition
      ? { key: activeScrollKey, position: savedScrollPosition }
      : null;
    if (!searchScrollActiveRef.current) {
      pendingInitialScrollRef.current = !savedScrollPosition;
    }
    setIsUserScrolledUp(Boolean(
      savedScrollPosition
      && !(savedScrollPosition.following ?? savedScrollPosition.distanceFromBottom <= CONVERSATION_SCROLL_BOTTOM_THRESHOLD)
    ));
  }, [activeScrollKey, setIsUserScrolledUp]);

  useLayoutEffect(() => {
    const pendingRestore = pendingConversationScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    if (
      !pendingRestore
      || pendingRestore.key !== activeScrollKey
      || !container
      || isLoadingSessionMessages
      || historyReadyScrollKey !== activeScrollKey
      || chatMessages.length === 0
    ) {
      return;
    }

    container.scrollTop = resolveConversationScrollTop(
      pendingRestore.position,
      container.scrollHeight,
      container.clientHeight,
    );
    const wasFollowing = pendingRestore.position.following
      ?? pendingRestore.position.distanceFromBottom <= CONVERSATION_SCROLL_BOTTOM_THRESHOLD;
    if (!wasFollowing && pendingRestore.position.anchor) restoreReadingAnchor(pendingRestore.position.anchor);
    else captureReadingAnchor();
    pendingConversationScrollRestoreRef.current = null;
    pendingInitialScrollRef.current = false;
  }, [activeScrollKey, historyReadyScrollKey, chatMessages.length, isLoadingSessionMessages, captureReadingAnchor, restoreReadingAnchor]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!activeScrollKey || !container || pendingConversationScrollRestoreRef.current
      || pendingInitialScrollRef.current || historyReadyScrollKeyRef.current !== activeScrollKey) return;
    conversationScrollPositionsRef.current.set(activeScrollKey, {
      top: container.scrollTop,
      distanceFromBottom: Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight),
      following: Boolean(autoScrollToBottom) && !isUserScrolledUp,
      anchor: getReadingAnchor(),
      historyStartId: activeSessionId ? sessionStore.getSessionSlot(activeSessionId)?.serverMessages[0]?.id : undefined,
    });
  }, [activeScrollKey, activeSessionId, historyReadyScrollKey, autoScrollToBottom, isUserScrolledUp, getReadingAnchor, sessionStore]);

  // Initial scroll to bottom
  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages
      || historyReadyScrollKeyRef.current !== activeScrollKey) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    pendingInitialScrollRef.current = false;
    if (!searchScrollActiveRef.current) scheduleInitialPosition();
  }, [activeScrollKey, historyReadyScrollKey, chatMessages.length, isLoadingSessionMessages, scheduleInitialPosition]);

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
      setSessionRuntimeState('inactive');
      setActiveRunId(null);
      setSessionLoadError(null);
      setCurrentSessionId(null);
      setHasMoreMessages(false);
      setTotalMessages(0);
      setIsLoadingSessionMessages(false);
      setIsLoadingMoreMessages(false);
      setIsLoadingAllMessages(false);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
      isLoadingMoreRef.current = false;
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    const provider = 'pilotdeck';
    const sessionKey = requestScope!.key;
    const isEnteringSession = lastLoadedSessionKeyRef.current !== sessionKey;
    const sessionChanged = didLoadedSessionChange(lastLoadedSessionKeyRef.current, sessionKey);
    const isPendingSessionHandoff = pendingViewSessionRef.current?.sessionId === selectedSession.id;

    if (isEnteringSession) {
      setSessionRuntimeState(
        sessionIsReadOnly
          ? 'inactive'
          : isPendingSessionHandoff && !sessionChanged
            ? 'running'
            : 'synchronizing',
      );
      if (sessionIsReadOnly) setActiveRunId(null);
    }

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
    if (sessionChanged) {
      resetStreamingState();
      activeRunIdRef.current = null;
      setActiveRunId(null);
      pendingViewSessionRef.current = null;
      setClaudeStatus(null);
      setPilotDeckStatus(null);
      setSessionLoadError(null);
      setCanAbortSession(false);
      setIsAborting(false);
    }

    // Reset pagination/scroll state
    setHasMoreMessages(false);
    setTotalMessages(0);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setViewHiddenCount(0);

    if (sessionChanged) {
      setTokenBudget(null);
      setIsLoading(false);
    }

    setCurrentSessionId(selectedSession.id);
    setSessionLoadError(null);
    setHistoryLoadError(false);
    setIsLoadingMoreMessages(false);
    isLoadingMoreRef.current = false;

    // Check session status
    if (ws && !sessionIsReadOnly) {
      invalidateSessionStatusResponses(selectedSession.id);
      const request = buildSessionStatusRequestIfIdle({
        sessionId: selectedSession.id,
        provider,
        expectedActiveRunId: activeRunIdRef.current,
        includeActiveTurnMessages: true,
      });
      if (request) sendMessage(request);
    }

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    // Read the newest complete turns first. Older pages use an absolute
    // backward identity cursor, so live appends cannot reorder history.
    const requestScrollKey = activeScrollKeyRef.current;
    const restorePosition = pendingConversationScrollRestoreRef.current?.key === requestScrollKey
      ? pendingConversationScrollRestoreRef.current.position : undefined;
    const restoreOlderWindow = restorePosition && !(restorePosition.following
      ?? restorePosition.distanceFromBottom <= CONVERSATION_SCROLL_BOTTOM_THRESHOLD);
    const isCurrent = requestScope!.capture();
    const budgetRevision = tokenBudgetRevision.current;
    requestHistory('initial', {
      includeFromId: restoreOlderWindow ? restorePosition.historyStartId : undefined,
    }).then(result => {
      if (!isCurrent()) return;
      historyReadyScrollKeyRef.current = requestScrollKey;
      setHistoryReadyScrollKey(requestScrollKey);
      if (result.status === 'success' && result.slot.tokenUsage && tokenBudgetRevision.current === budgetRevision) {
        // The dedicated token request may replace this history estimate;
        // realtime budgets and an already-resolved token request take priority.
        setTokenBudgetState(result.slot.tokenUsage as Record<string, unknown>);
      }
      setIsLoadingSessionMessages(false);
    });
  }, [
    currentSessionId,
    pendingViewSessionRef,
    resetStreamingState,
    selectedProject,
    selectedSession,
    sendMessage,
    setIsLoading,
    ws,
    sessionIsReadOnly,
    sessionRequestParams,
    sessionStore,
    requestScope,
    requestHistory,
    setTokenBudget,
  ]);

  // A revision belongs to the view that received it, even while streaming.
  const consumedExternalRevision = useRef(externalMessageUpdate ?? 0);
  const pendingExternalUpdate = useRef<typeof requestScope>(null);
  useEffect(() => {
    const revision = externalMessageUpdate ?? 0;
    if (revision !== consumedExternalRevision.current) {
      consumedExternalRevision.current = revision;
      const matchesTarget = !externalMessageUpdateTarget || (requestScope
        && externalMessageUpdateTarget.projectName === requestScope.projectName
        && externalMessageUpdateTarget.sessionId === requestScope.sessionId
        && externalMessageUpdateTarget.relativeTranscriptPath === requestScope.options.relativeTranscriptPath);
      pendingExternalUpdate.current = matchesTarget ? requestScope : null;
    }
    if (pendingExternalUpdate.current !== requestScope) pendingExternalUpdate.current = null;
    if (!requestScope || !pendingExternalUpdate.current || isLoading || isLoadingSessionMessages) return;
    pendingExternalUpdate.current = null;
    const isCurrent = requestScope.capture();
    void refreshSessionMessages().then(result => {
      if (isCurrent() && result.status === 'success' && autoScrollToBottom && isNearBottom()) scheduleScrollToBottom();
    });
  }, [autoScrollToBottom, externalMessageUpdate, externalMessageUpdateTarget, isNearBottom,
    scheduleScrollToBottom, requestScope, refreshSessionMessages, isLoading, isLoadingSessionMessages]);

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
  const hasChatMessages = chatMessages.length > 0;
  useEffect(() => {
    if (!searchTarget || !hasChatMessages || isLoadingSessionMessages) return;

    const target = searchTarget;
    setIsUserScrolledUp(true);
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const container = scrollContainerRef.current;
    const later = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => { timers.delete(timer); if (!cancelled) callback(); }, delay);
      timers.add(timer);
    };
    const cancelNavigation = () => {
      cancelled = true;
      searchScrollActiveRef.current = false;
      setSearchTarget(null);
    };
    const cancelOnKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelNavigation();
    };
    container?.addEventListener('wheel', cancelNavigation, { passive: true });
    container?.addEventListener('touchmove', cancelNavigation, { passive: true });
    container?.addEventListener('keydown', cancelOnKey);

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
        {
          try {
            await loadAllMessages();
            if (cancelled) return;
            if (allMessagesLoadedRef.current) {
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          }
        }
      }
      if (cancelled) return;

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
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          searchScrollActiveRef.current = false;
          setSearchTarget(null);
        } else if (retriesLeft > 0) {
          later(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
          setSearchTarget(null);
        }
      };

      later(() => findAndScroll(15), 150);
    };

    scrollToTarget();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      container?.removeEventListener('wheel', cancelNavigation);
      container?.removeEventListener('touchmove', cancelNavigation);
      container?.removeEventListener('keydown', cancelOnKey);
      searchScrollActiveRef.current = false;
    };
  }, [hasChatMessages, isLoadingSessionMessages, searchTarget, selectedProject, selectedSession, loadAllMessages, setIsUserScrolledUp]);

  useEffect(() => {
    if (!requestScope || requestScope.sessionId.startsWith('new-session-') || requestScope.readOnly) {
      setTokenBudget(null);
      return;
    }
    const isCurrent = requestScope.capture();
    const revision = tokenBudgetRevision.current;
    const abort = new AbortController();
    const fetchInitialTokenUsage = async () => {
      try {
        const url = `/api/projects/${encodeURIComponent(requestScope.projectName)}/sessions/${encodeURIComponent(requestScope.sessionId)}/token-usage?provider=pilotdeck`;
        const response = await authenticatedFetch(url, { signal: abort.signal });
        const budget = response.ok ? await response.json() : null;
        if (isCurrent() && !abort.signal.aborted && revision === tokenBudgetRevision.current) setTokenBudget(budget);
      } catch (error) {
        if (!abort.signal.aborted && isCurrent()) console.error('Failed to fetch initial token usage:', error);
      }
    };
    void fetchInitialTokenUsage();
    return () => abort.abort();
  }, [requestScope, setTokenBudget]);

  // Transport pages retain whole turns; DOM windowing owns rendering limits.
  const visibleMessages = chatMessages;
  const visibleMessageCount = chatMessages.length;

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
    if (sessionIsReadOnly) return;
    if (!activeViewSessionId || !processingSessions) return;
    const shouldBeProcessing = processingSessions.has(activeViewSessionId);
    if (shouldBeProcessing && !isLoading) {
      setIsLoading(true);
      setCanAbortSession(true);
    }
  }, [
    currentSessionId,
    isLoading,
    pendingViewSessionRef,
    processingSessions,
    selectedSession?.id,
    sessionIsReadOnly,
    setIsLoading,
  ]);

  useEffect(() => {
    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const activeViewSessionId =
      selectedSession?.id || (pendingSessionId === currentSessionId ? currentSessionId : null);
    if (sessionIsReadOnly) return;
    if (!activeViewSessionId || !processingSessions) return;
    if (!processingSessions.has(activeViewSessionId)) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const requestStatus = () => {
      const request = buildSessionStatusRequestIfIdle({
        sessionId: activeViewSessionId,
        provider: 'pilotdeck',
        expectedActiveRunId: activeRunIdRef.current,
        includeActiveTurnMessages: false,
      });
      if (request) sendMessage(request);
    };

    requestStatus();
    const timer = setInterval(requestStatus, 1200);
    return () => clearInterval(timer);
  }, [
    currentSessionId,
    pendingViewSessionRef,
    processingSessions,
    selectedSession?.id,
    sendMessage,
    sessionIsReadOnly,
    ws,
  ]);

  const loadEarlierMessages = useCallback(() => {
    setHistoryLoadError(false);
    if (scrollContainerRef.current) void loadOlderMessages(scrollContainerRef.current);
  }, [loadOlderMessages]);

  return {
    chatMessages,
    activityMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    sessionRuntimeState,
    setSessionRuntimeState,
    activeRunId,
    setActiveRunId,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    sessionLoadError,
    retrySessionMessages,
    refreshSessionMessages,
    isLoadingMoreMessages,
    historyLoadError,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isAborting,
    setIsAborting,
    isUserScrolledUp,
    canReturnToLatest,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    claudeStatus,
    setClaudeStatus,
    pilotDeckStatus,
    setPilotDeckStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    scheduleScrollToBottom,
    pauseScrollFollowing,
    isNearBottom,
    handleScroll,
  };
}
