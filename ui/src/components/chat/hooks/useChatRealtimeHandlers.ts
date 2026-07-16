import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ClaudeWorkStatus, CompactProgress, PendingPermissionRequest, PilotDeckWorkStatus } from '../types/types';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import { useWebSocket } from '../../../contexts/WebSocketContext';

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

function normalizeAssistantStreamText(value?: string): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function parseAssistantStreamTimestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCompatibleAssistantStreamRun(incoming: NormalizedMessage, existing: NormalizedMessage): boolean {
  if (incoming.runId != null && existing.runId != null) return incoming.runId === existing.runId;
  const isActiveStream = existing.kind === 'stream_delta' && String(existing.id || '').startsWith('__streaming_');
  if (!isActiveStream) return false;
  const incomingTimestamp = parseAssistantStreamTimestamp(incoming.timestamp);
  const existingTimestamp = parseAssistantStreamTimestamp(existing.timestamp);
  if (incomingTimestamp == null || existingTimestamp == null) return false;
  return Math.abs(incomingTimestamp - existingTimestamp) <= 10_000;
}

export function getDuplicateAssistantStreamTextState(
  incoming: NormalizedMessage,
  realtimeMessages: NormalizedMessage[],
): { isDuplicate: boolean; hasActiveStream: boolean; activeStreamRunId?: string | null } {
  if (incoming.kind !== 'text' || incoming.role !== 'assistant') {
    return { isDuplicate: false, hasActiveStream: false };
  }

  const incomingText = normalizeAssistantStreamText(incoming.content);
  if (!incomingText) {
    return { isDuplicate: false, hasActiveStream: false };
  }

  let hasActiveStream = false;
  let activeStreamRunId: string | null | undefined;
  const isDuplicate = realtimeMessages.some((message) => {
    const isAssistantText = message.kind === 'text' && message.role === 'assistant';
    const isActiveStream = message.kind === 'stream_delta' && String(message.id || '').startsWith('__streaming_');
    if (!isAssistantText && !isActiveStream) return false;
    if (isAssistantText && (incoming.runId == null || message.runId == null)) return false;
    if (!isCompatibleAssistantStreamRun(incoming, message)) return false;
    if (normalizeAssistantStreamText(message.content) !== incomingText) return false;
    if (isActiveStream) {
      hasActiveStream = true;
      activeStreamRunId = message.runId ?? null;
    }
    return true;
  });

  return { isDuplicate, hasActiveStream, activeStreamRunId };
}


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
  selectedProject,
  onReplaceTemporarySession,
  onNavigateToSession,
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const { subscribe } = useWebSocket();

  // Track which sessions have active thinking (just a boolean flag now)
  const thinkingBySessionRef = useRef<Map<string, boolean>>(new Map());
  // Dedup volatile active-turn replay chunks across reconnect/status polls.
  const activeTurnReplaySignatureRef = useRef<Map<string, string>>(new Map());

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
      thinkingBySessionRef.current.clear();
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
            clearAccumulators();
            const slot = sessionStore.getSessionSlot?.(statusSessionId);
            const hasLiveStreaming = Boolean(slot?.realtimeMessages?.some((message) => (
              message.id === `__streaming_${statusSessionId}`
              || message.id.startsWith(`__streaming_${statusSessionId}_`)
              || message.id === `__streaming_thinking_${statusSessionId}`
              || message.id.startsWith(`__streaming_thinking_${statusSessionId}_`)
            )));
            const replayedToolIds = new Set(
              (slot?.realtimeMessages || [])
                .filter((message) => message.kind === 'tool_use' && typeof message.toolId === 'string')
                .map((message) => message.toolId as string),
            );
            const activeTurnToolIds = new Set(
              msg.activeTurnMessages
                .filter((message) => message?.kind === 'tool_use' && typeof message?.toolId === 'string')
                .map((message) => message.toolId as string),
            );
            const hasReplayedCurrentTurnToolUse = activeTurnToolIds.size > 0
              && [...activeTurnToolIds].some((toolId) => replayedToolIds.has(toolId));
            const volatileSignature = msg.activeTurnMessages
              .filter((message) => ['thinking', 'stream_delta', 'stream_end'].includes(String(message?.kind)))
              .map((message) => `${message.kind}:${message.id || ''}:${message.content || ''}`)
              .join('||');
            const previousVolatileSignature = activeTurnReplaySignatureRef.current.get(statusSessionId);
            const hasSeenSameVolatileReplay = Boolean(
              volatileSignature && previousVolatileSignature === volatileSignature,
            );
            // Only replay messages that have stable IDs and can be deduped
            // against server data (tool_use by toolId, tool_result/status by id).
            // Skip thinking, stream_delta, stream_end — these create messages
            // with generated IDs that can't be matched to server copies.
            // But if this tab has no active streaming state (e.g. another tab
            // started the turn), we need to replay them so content renders.
            const skipKinds = new Set(['thinking', 'stream_delta', 'stream_end']);
            const skipVolatileReplay =
              hasLiveStreaming || hasReplayedCurrentTurnToolUse || hasSeenSameVolatileReplay;
            for (const activeTurnMessage of msg.activeTurnMessages) {
              if (skipVolatileReplay && skipKinds.has(activeTurnMessage.kind)) continue;
              handleMessage(activeTurnMessage, statusSessionId);
            }
            if (volatileSignature) {
              activeTurnReplaySignatureRef.current.set(statusSessionId, volatileSignature);
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
    const msgRunId = typeof msg.runId === 'string' && msg.runId.trim() ? msg.runId.trim() : undefined;
    const streamKey = msgRunId ? `${sid}_${msgRunId}` : sid;

    if (!getExplicitSessionId(msg) && fallbackSessionId) {
      warnResolvedSessionId(msg, sid);
    }

    const isForActiveView =
      sid === currentSessionId ||
      sid === selectedSession?.id ||
      sid === activeViewSessionId;

    // Ensure the store's activeSession matches so notify() triggers re-renders.
    // Without this, the RAF scheduler silently drops notifications for
    // sessions it doesn't consider "active", causing content to not render
    // until some other state change (like clicking stop) triggers a re-render.
    if (isForActiveView) {
      sessionStore.setActiveSession(sid);
    }

    if (msg.kind === 'text' && msg.role === 'user') {
      if (thinkingBySessionRef.current.has(sid)) {
        thinkingBySessionRef.current.delete(sid);
      }
    }

    if (msg.kind === 'agent_activity') {
      const activitySubagentId = typeof msg.subagentId === 'string'
        ? msg.subagentId
        : String(msg.activityId || '').startsWith('subagent:')
          ? String(msg.activityId).slice('subagent:'.length)
          : '';
      if (
        activitySubagentId &&
        msg.phase === 'subagent' &&
        ['completed', 'failed', 'cancelled'].includes(String(msg.state || ''))
      ) {
        sessionStore.finalizeSubagentDetailThinking?.(sid, activitySubagentId);
        sessionStore.finalizeSubagentDetailStreaming?.(sid, activitySubagentId);
      }
      sessionStore.upsertActivity?.(sid, msg as NormalizedMessage);
      return;
    }

    if (msg.kind === 'subagent_link') {
      sessionStore.recordSubagentLink?.(sid, msg as NormalizedMessage);
      return;
    }

    const subagentId = typeof msg.subagentId === 'string' ? msg.subagentId : '';
    if (msg.isSubagentDetail && subagentId) {
      if (msg.kind === 'thinking') {
        sessionStore.updateSubagentDetailThinking?.(
          sid,
          subagentId,
          msg.content || '',
          provider,
        );
        return;
      }
      if (msg.kind === 'stream_delta') {
        sessionStore.finalizeSubagentDetailThinking?.(sid, subagentId);
        sessionStore.updateSubagentDetailStreaming?.(
          sid,
          subagentId,
          msg.content || '',
          provider,
        );
        return;
      }
      if (msg.kind === 'stream_end') {
        sessionStore.finalizeSubagentDetailThinking?.(sid, subagentId);
        sessionStore.finalizeSubagentDetailStreaming?.(sid, subagentId);
        return;
      }
      sessionStore.finalizeSubagentDetailThinking?.(sid, subagentId);
      sessionStore.finalizeSubagentDetailStreaming?.(sid, subagentId);
      sessionStore.appendSubagentDetailMessage?.(sid, subagentId, msg as NormalizedMessage);
      return;
    }

    // --- Streaming: direct accumulation (no smoother animation) ---
    if (msg.kind === 'stream_delta') {
      const text = msg.content || '';
      if (!text) return;
      // Content starting means thinking is done
      if (thinkingBySessionRef.current.has(sid)) {
        thinkingBySessionRef.current.delete(sid);
        sessionStore.finalizeStreamingThinking(sid, msgRunId);
      }
      const slot = sessionStore.getSessionSlot?.(sid);
      const streamId = `__streaming_${streamKey}`;
      const existing = slot?.realtimeMessages.find((m: any) => m.id === streamId);
      const currentText = existing?.content || '';
      sessionStore.updateStreaming(sid, currentText + text, provider, msgRunId);
      return;
    }

    // --- Thinking: direct accumulation (same as content) ---
    if (msg.kind === 'thinking') {
      const text = msg.content || '';
      if (!text) return;
      // Mark that thinking is active
      thinkingBySessionRef.current.set(sid, true as any);
      // Read current thinking content and append delta
      const slot = sessionStore.getSessionSlot?.(sid);
      const streamId = `__streaming_thinking_${streamKey}`;
      const existing = slot?.realtimeMessages.find((m: any) => m.id === streamId);
      const currentText = existing?.content || '';
      sessionStore.updateStreamingThinking(sid, currentText + text, provider, msgRunId);
      return;
    }

    // --- Stream end: finalize content stream ---
    if (msg.kind === 'stream_end') {
      // Finalize thinking if still active
      if (thinkingBySessionRef.current.has(sid)) {
        thinkingBySessionRef.current.delete(sid);
        sessionStore.finalizeStreamingThinking(sid, msgRunId);
      }
      sessionStore.finalizeStreaming(sid, msgRunId);
      return;
    }

    // Only route certain message kinds to the store append logic.
    const flushKinds = new Set([
      'tool_use', 'tool_result', 'text', 'complete', 'error', 'permission_request',
    ]);
    if (flushKinds.has(msg.kind as string)) {
      // Finalize thinking if still active (model moved past thinking)
      if (thinkingBySessionRef.current.has(sid)) {
        thinkingBySessionRef.current.delete(sid);
        sessionStore.finalizeStreamingThinking(sid, msgRunId);
      }
      // Finalize content stream on tool_use / complete / error.
      // The gateway may not send stream_end, so tool_use is the
      // reliable signal that the text block has ended.
      if (msg.kind === 'tool_use' || msg.kind === 'complete' || msg.kind === 'error') {
        sessionStore.finalizeStreaming(sid, msgRunId);
      }
      if (msg.kind === 'complete' || msg.kind === 'error') {
        sessionStore.finalizeStreamingThinking(sid, msgRunId);
      }
    }

    // --- All other messages: route to store ---
    // Skip assistant text messages that duplicate finalized streaming content.
    // The streaming pipeline (stream_delta → stream_end → finalizeStreaming)
    // already creates a text message in realtimeMessages. If the backend also
    // sends a standalone 'text' message with the same content, skip it.
    const duplicateStreamTextState = getDuplicateAssistantStreamTextState(
      msg as NormalizedMessage,
      sessionStore.getSessionSlot?.(sid)?.realtimeMessages ?? [],
    );
    if (duplicateStreamTextState.hasActiveStream) {
      sessionStore.finalizeStreaming(sid, duplicateStreamTextState.activeStreamRunId ?? undefined);
    }
    if (!duplicateStreamTextState.isDuplicate) {
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
          activeTurnReplaySignatureRef.current.delete(sid);
          // Finalize both thinking and content streams
          if (thinkingBySessionRef.current.has(sid)) {
            thinkingBySessionRef.current.delete(sid);
          }
          sessionStore.finalizeStreamingThinking(sid, msgRunId);
          sessionStore.finalizeStreaming(sid, msgRunId);
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
          window.dispatchEvent(new CustomEvent('pilotdeck:agent-turn-complete', {
            detail: {
              sessionId: sid,
              projectName: selectedProject?.name,
              projectPath: selectedProject?.fullPath || selectedProject?.path || '',
            },
          }));

          // Auto-refresh from server to align with canonical message order.
          // During streaming, messages may arrive out of order (e.g. content
          // stream created before tool_use). The server has the authoritative
          // copy with correct ordering. Retry if server hasn't committed yet.
          const doRefresh = (attempt: number) => {
            sessionStore.refreshFromServer(sid, { provider, projectName: selectedProject?.name, projectPath: selectedProject?.fullPath || selectedProject?.path || '' }).then(() => {
              const slot = sessionStore.getSessionSlot?.(sid);
              if (slot && slot.serverMessages.length === 0 && attempt < 5) {
                setTimeout(() => doRefresh(attempt + 1), 1500 * attempt);
              }
            });
          };
          doRefresh(1);
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
          activeTurnReplaySignatureRef.current.delete(sid);
          onSessionInactive?.(sid);
          onSessionNotProcessing?.(sid);
          sessionStore.refreshFromServer(sid, { provider, projectName: selectedProject?.name, projectPath: selectedProject?.fullPath || selectedProject?.path || '' });
        }
        break;
      }

      case 'permission_request': {
        if (!msg.requestId) break;
        const isForCurrentSession = isForActiveView;
        if (!isForCurrentSession) break;
        onSessionProcessing?.(sid);
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
        if (msg.text && msg.text !== 'token_budget' && msg.text !== 'clear_status') {
          onSessionProcessing?.(sid);
        }
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
            retryProgress: msg.retryProgress || null,
          });
          setIsLoading(true);
          setCanAbortSession(msg.canInterrupt !== false);
        }
        break;
      }

      case 'compact_boundary': {
        onSessionProcessing?.(sid);
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
    selectedProject,
    sessionStore,
  ]);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe(handleMessage as (msg: any) => void);
  }, [subscribe, handleMessage]);
}
