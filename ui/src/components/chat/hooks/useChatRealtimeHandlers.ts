import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ClaudeWorkStatus, CompactProgress, PendingPermissionRequest, PilotDeckWorkStatus } from '../types/types';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { SmoothTextStream } from './streamSmoother';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

type LatestChatMessage = {
  type?: string;
  kind?: string;
  data?: any;
  message?: any;
  delta?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  error?: string;
  tool?: any;
  toolId?: string;
  result?: any;
  exitCode?: number;
  isProcessing?: boolean;
  actualSessionId?: string;
  event?: string;
  status?: any;
  isNewSession?: boolean;
  activeTurnMessages?: LatestChatMessage[];
  activitySnapshot?: LatestChatMessage[];
  compactProgress?: CompactProgress;
  compact_progress?: CompactProgress;
  resultText?: string;
  isError?: boolean;
  success?: boolean;
  reason?: string;
  provider?: string;
  content?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  newSessionId?: string;
  aborted?: boolean;
  [key: string]: any;
};

type StreamSmootherMap = Map<string, SmoothTextStream>;

function getExplicitSessionId(msg: LatestChatMessage): string | null {
  const value = msg.sessionId ?? msg.session_id ?? msg.actualSessionId ?? msg.newSessionId;
  return typeof value === 'string' && value.trim() ? value : null;
}

function resolveSessionId(
  msg: LatestChatMessage,
  fallbackSessionId?: string | null,
): string | null {
  const explicit = getExplicitSessionId(msg);
  if (explicit) return explicit;
  if (typeof fallbackSessionId === 'string' && fallbackSessionId.trim()) {
    return fallbackSessionId.trim();
  }
  return null;
}

function warnDroppedFrame(msg: LatestChatMessage): void {
  console.warn('[chat] Dropped WS frame without sessionId', {
    kind: msg.kind,
    type: msg.type,
  });
}

function warnResolvedSessionId(msg: LatestChatMessage, fallbackSessionId: string): void {
  console.warn('[chat] Resolved missing sessionId from parent context', {
    kind: msg.kind,
    type: msg.type,
    fallbackSessionId,
  });
}

function getOrCreateSmoother(
  map: StreamSmootherMap,
  sessionId: string,
  create: () => SmoothTextStream,
): SmoothTextStream {
  let state = map.get(sessionId);
  if (!state) {
    state = create();
    map.set(sessionId, state);
  }
  return state;
}

interface UseChatRealtimeHandlersArgs {
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setIsAborting: (aborting: boolean) => void;
  setClaudeStatus: (status: ClaudeWorkStatus | null) => void;
  setPilotDeckStatus: (status: PilotDeckWorkStatus | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string) => void;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatRealtimeHandlers({
  provider,
  selectedSession,
  currentSessionId,
  setCurrentSessionId,
  setIsLoading,
  setCanAbortSession,
  setIsAborting,
  setClaudeStatus,
  setPilotDeckStatus,
  setTokenBudget,
  setPendingPermissionRequests,
  pendingViewSessionRef,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onReplaceTemporarySession,
  onNavigateToSession,
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const { subscribe } = useWebSocket();

  const streamBySessionRef = useRef<StreamSmootherMap>(new Map());
  const thinkingBySessionRef = useRef<StreamSmootherMap>(new Map());

  const handleMessage = useCallback((latestMessage: LatestChatMessage, fallbackSessionId?: string | null) => {
    if (!latestMessage) return;

    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const activeCurrentSessionId =
      pendingSessionId === currentSessionId ? currentSessionId : null;
    const activeViewSessionId =
      selectedSession?.id || activeCurrentSessionId || pendingSessionId || null;

    /* ---------------------------------------------------------------- */
    /*  Legacy messages (no `kind` field) — handle and return           */
    /* ---------------------------------------------------------------- */

    const msg = latestMessage as any;
    const clearAccumulators = () => {
      for (const state of streamBySessionRef.current.values()) {
        state.cancel();
      }
      for (const state of thinkingBySessionRef.current.values()) {
        state.cancel();
      }
      streamBySessionRef.current.clear();
      thinkingBySessionRef.current.clear();
    };
    const flushStream = (sessionId: string, finalize = false) => {
      const state = streamBySessionRef.current.get(sessionId);
      if (!state) return;
      state.flush(finalize);
      if (finalize) {
        streamBySessionRef.current.delete(sessionId);
      }
    };
    const flushThinking = (sessionId: string, finalize = false) => {
      const state = thinkingBySessionRef.current.get(sessionId);
      if (!state) return;
      state.flush(finalize);
      if (finalize) {
        thinkingBySessionRef.current.delete(sessionId);
      }
    };

    if (!msg.kind) {
      const messageType = String(msg.type || '');

      switch (messageType) {
        case 'websocket-reconnected':
          clearAccumulators();
          onWebSocketReconnect?.();
          return;

        case 'pending-permissions-response': {
          const permSessionId = msg.sessionId;
          const isCurrentPermSession =
            permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
          if (permSessionId && !isCurrentPermSession) return;
          setPendingPermissionRequests(msg.data || []);
          return;
        }

        case 'session-status': {
          const statusSessionId = msg.sessionId;
          if (!statusSessionId) return;
          const isCurrentSession =
            statusSessionId === currentSessionId || (selectedSession && statusSessionId === selectedSession.id);

          if (isCurrentSession && Array.isArray(msg.activeTurnMessages) && msg.activeTurnMessages.length > 0) {
            for (const activeTurnMessage of msg.activeTurnMessages) {
              handleMessage(activeTurnMessage, statusSessionId);
            }
          }

          if (isCurrentSession && Array.isArray(msg.activitySnapshot)) {
            const activities = msg.activitySnapshot.map((activity) => {
              const normalized = activity as NormalizedMessage;
              if (getExplicitSessionId(normalized)) return normalized;
              return { ...normalized, sessionId: statusSessionId };
            });
            sessionStore.setActivities?.(statusSessionId, activities);
          }

          const status = msg.status;
          if (status) {
            if (!isCurrentSession) return;
            const statusInfo = {
              text: status.text || 'Working...',
              tokens: status.tokens || 0,
              can_interrupt: status.can_interrupt !== undefined ? status.can_interrupt : true,
              compactProgress: status.compactProgress || status.compact_progress || null,
            };
            setClaudeStatus(statusInfo);
            setPilotDeckStatus(statusInfo);
            setIsLoading(true);
            setCanAbortSession(statusInfo.can_interrupt);
            return;
          }

          if (isCurrentSession && msg.tokenBudget) {
            setTokenBudget(msg.tokenBudget as Record<string, unknown>);
          }

          // Legacy isProcessing format from check-session-status
          if (msg.isProcessing) {
            onSessionProcessing?.(statusSessionId);
            if (isCurrentSession) { setIsLoading(true); setCanAbortSession(true); }
            return;
          }
          onSessionInactive?.(statusSessionId);
          onSessionNotProcessing?.(statusSessionId);
          if (isCurrentSession) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
            setPilotDeckStatus(null);
          }
          return;
        }

        default:
          // Unknown legacy message type — ignore
          return;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  NormalizedMessage handling (has `kind` field)                    */
    /* ---------------------------------------------------------------- */

    const sid = resolveSessionId(msg, fallbackSessionId);
    if (!sid) {
      warnDroppedFrame(msg);
      return;
    }
    if (!getExplicitSessionId(msg) && fallbackSessionId) {
      warnResolvedSessionId(msg, sid);
    }

    const isForActiveView =
      sid === currentSessionId ||
      sid === selectedSession?.id ||
      sid === activeViewSessionId;

    if (msg.kind === 'agent_activity') {
      sessionStore.upsertActivity?.(sid, msg as NormalizedMessage);
      return;
    }

    // --- Streaming: buffer for performance ---
    if (msg.kind === 'stream_delta') {
      const text = msg.content || '';
      if (!text) return;
      // Flush this session's thinking before its assistant text starts.
      flushThinking(sid, true);
      const state = getOrCreateSmoother(
        streamBySessionRef.current,
        sid,
        () => new SmoothTextStream({
          emit: (content) => sessionStore.updateStreaming(sid, content, provider),
          finalize: () => sessionStore.finalizeStreaming(sid),
        }),
      );
      state.append(text);
      return;
    }

    // --- Thinking: accumulate into a single message like stream_delta ---
    if (msg.kind === 'thinking') {
      const text = msg.content || '';
      if (!text) return;
      const state = getOrCreateSmoother(
        thinkingBySessionRef.current,
        sid,
        () => new SmoothTextStream({
          emit: (content) => sessionStore.updateStreamingThinking(sid, content, provider),
          finalize: () => sessionStore.finalizeStreamingThinking(sid),
        }),
      );
      state.append(text);
      return;
    }

    if (msg.kind === 'stream_end') {
      flushStream(sid, true);
      return;
    }

    // --- Turn boundary: finalize in-flight streaming before non-stream msgs ---
    flushThinking(sid, true);
    flushStream(sid, true);

    // --- All other messages: route to store ---
    // Skip assistant text messages that duplicate finalized streaming content.
    // The streaming pipeline (stream_delta → stream_end → finalizeStreaming)
    // already creates a text message in realtimeMessages. If the backend also
    // sends a standalone 'text' message with the same content, skip it.
    const isDuplicateStreamText =
      msg.kind === 'text' && msg.role === 'assistant' &&
      sessionStore.getSessionSlot?.(sid)?.realtimeMessages.some(
        (m) => m.kind === 'text' && m.role === 'assistant' && m.content === (msg as NormalizedMessage).content,
      );
    if (!isDuplicateStreamText) {
      sessionStore.appendRealtime(sid, msg as NormalizedMessage);
    }

    // --- UI side effects for specific kinds ---
    switch (msg.kind) {
      case 'session_created': {
        const newSessionId = msg.newSessionId;
        if (!newSessionId) break;

        if (!currentSessionId || currentSessionId.startsWith('new-session-')) {
          sessionStorage.setItem('pendingSessionId', newSessionId);
          if (pendingViewSessionRef.current && !pendingViewSessionRef.current.sessionId) {
            pendingViewSessionRef.current.sessionId = newSessionId;
          }
          setCurrentSessionId(newSessionId);
          // Eagerly set activeSession so that notify() works for
          // stream_delta events that arrive before React re-renders.
          sessionStore.setActiveSession(newSessionId);
          onReplaceTemporarySession?.(newSessionId);
          setPendingPermissionRequests((prev) =>
            prev.map((r) => (r.sessionId ? r : { ...r, sessionId: newSessionId })),
          );
          onNavigateToSession?.(newSessionId);
        }
        if (window.refreshProjects) {
          void window.refreshProjects();
        }
        break;
      }

      case 'complete': {
        if (sid) {
          flushThinking(sid, true);
          flushStream(sid, true);
        }

        if (isForActiveView) {
          setIsLoading(false);
          setCanAbortSession(false);
          setIsAborting(false);
          setClaudeStatus(null);
          setPilotDeckStatus(null);
        }
        if (sid) {
          setPendingPermissionRequests((prev) =>
            prev.filter((r) => r.sessionId !== sid),
          );
          onSessionInactive?.(sid);
          onSessionNotProcessing?.(sid);
        }

        // Handle aborted case
        if (msg.aborted) {
          // Abort was requested — the complete event confirms it
          // No special UI action needed beyond clearing loading state above
          // The backend already sent any abort-related messages
          break;
        }

        // Clear pending session
        const pendingSessionId = sessionStorage.getItem('pendingSessionId');
        if (pendingSessionId && sid === pendingSessionId && msg.exitCode === 0) {
          const actualId = msg.actualSessionId || pendingSessionId;
          if (!currentSessionId) {
            setCurrentSessionId(actualId);
          }
          if (msg.actualSessionId) {
            onNavigateToSession?.(actualId);
          }
          sessionStorage.removeItem('pendingSessionId');
          if (window.refreshProjects) {
            setTimeout(() => window.refreshProjects?.(), 500);
          }
        }
        break;
      }

      case 'error': {
        if (isForActiveView) {
          setIsLoading(false);
          setCanAbortSession(false);
          setIsAborting(false);
          setClaudeStatus(null);
          setPilotDeckStatus(null);
        }
        if (sid) {
          onSessionInactive?.(sid);
          onSessionNotProcessing?.(sid);
        }
        break;
      }

      case 'permission_request': {
        if (!msg.requestId) break;
        const isForCurrentSession = isForActiveView;
        if (!isForCurrentSession) break;
        setPendingPermissionRequests((prev) => {
          if (prev.some((r: PendingPermissionRequest) => r.requestId === msg.requestId)) return prev;
          return [...prev, {
            requestId: msg.requestId,
            toolName: msg.toolName || 'UnknownTool',
            input: msg.input,
            context: msg.context,
            sessionId: sid,
            receivedAt: new Date(),
            isElicitation: Boolean((msg as { isElicitation?: boolean }).isElicitation),
          }];
        });
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({ text: 'Waiting for permission', tokens: 0, can_interrupt: true });
        setPilotDeckStatus({ text: 'Waiting for permission', tokens: 0, can_interrupt: true });
        break;
      }

      case 'permission_cancelled': {
        if (msg.requestId) {
          setPendingPermissionRequests((prev) => prev.filter((r: PendingPermissionRequest) => r.requestId !== msg.requestId));
        }
        break;
      }

      case 'status': {
        if (!isForActiveView) break;
        if (msg.text === 'token_budget' && msg.tokenBudget) {
          setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        } else if (msg.text === 'clear_status') {
          setClaudeStatus(null);
          setPilotDeckStatus(null);
        } else if (msg.text) {
          setClaudeStatus({
            text: msg.text,
            tokens: msg.tokens || 0,
            can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
            compactProgress: msg.compactProgress || msg.compact_progress || null,
          });
          setPilotDeckStatus({
            text: msg.text,
            tokens: msg.tokens || 0,
            can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
            compactProgress: msg.compactProgress || msg.compact_progress || null,
          });
          setIsLoading(true);
          setCanAbortSession(msg.canInterrupt !== false);
        }
        break;
      }

      case 'compact_boundary': {
        if (isForActiveView) {
          setClaudeStatus(null);
          setPilotDeckStatus(null);
          setIsLoading(true);
          setCanAbortSession(true);
        }
        break;
      }

      // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
      // → already routed to store above, no UI side effects needed
      default:
        break;
    }
  }, [
    provider,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setPilotDeckStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onNavigateToSession,
    onWebSocketReconnect,
    sessionStore,
  ]);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe(handleMessage as (msg: any) => void);
  }, [subscribe, handleMessage]);
}
