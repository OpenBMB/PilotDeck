/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { SessionProvider } from '../types/app';
import { authenticatedFetch, readAgentStatusErrorFromResponse } from '../utils/api';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification'
  | 'interrupted'
  | 'compact_boundary'
  | 'agent_activity'
  | 'agent_activity_summary'
  | 'file_artifacts';

export interface CompactProgress {
  level: number;
  stage: string;
  label: string;
  state: 'started' | 'running' | 'failed' | 'completed';
  pre_tokens?: number;
  reason?: string;
}

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: SessionProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  contentI18n?: { key: string; params?: Record<string, unknown> };
  userHintI18n?: { key: string; params?: Record<string, unknown> };
  images?: string[];
  attachments?: Array<{
    kind?: 'file' | 'document-selection';
    name: string;
    path?: string;
    size?: number;
    mimeType?: string;
    fileName?: string;
    filePath?: string;
    source?: 'pdf' | 'office-pdf';
    pageNumbers?: number[];
    selectedText?: string;
    surroundingText?: string;
    occurrenceIndex?: number | null;
    createdAt?: string;
    truncated?: boolean;
  }>;
  artifacts?: Array<{
    id: string;
    name: string;
    path: string;
    operation: 'created' | 'updated';
    source: 'tool' | 'workspace_diff';
    status: 'complete' | 'incomplete';
    size: number;
    sha256: string;
    mimeType?: string;
    createdAt: string;
  }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  /**
   * Inline image payloads attached to a `tool_result` frame (e.g. `read_file`
   * on a PNG). Object shape with `data` (data URL) and optional `mimeType` —
   * distinct from `images?: string[]` above, which carries user-message
   * upload data URLs. The bridge wraps gateway base64 as data URLs upstream
   * so the UI can drop these straight into `<img src>` without re-parsing.
   */
  toolResultImages?: Array<{ data: string; mimeType?: string; name?: string }>;
  isError?: boolean;
  /**
   * `PilotDeckToolErrorCode` from the gateway when `kind === 'tool_result'`
   * and `isError === true` — flat on the frame because the bridge merges
   * `tool_call_finished.errorCode` here verbatim. See
   * `pilotdeck-bridge.js#tool_call_finished` and `chatPermissions.ts`.
   */
  errorCode?: string;
  resultPath?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  compactProgress?: CompactProgress;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentId?: string;
  isSubagentDetail?: boolean;
  subagentTools?: unknown[];
  taskId?: string;
  outputFile?: string;
  taskResult?: string;
  trigger?: string;
  preTokens?: number;
  compactLevel?: number;
  compactStage?: string;
  compactStageLabel?: string;
  compactMetadata?: unknown;
  runId?: string;
  activityId?: string;
  phase?: string;
  state?: string;
  title?: string;
  detail?: string;
  startedAt?: string;
  endedAt?: string | null;
  durationMs?: number | null;
  severity?: string;
  toolCallCount?: number;
  toolErrorCount?: number;
  ragSearchCount?: number;
  compactCount?: number;
  editedFileCount?: number;
  exploredFileCount?: number;
  commandCount?: number;
  subagentCount?: number;
  thinkingCount?: number;
  otherToolCount?: number;
  keySteps?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
  /** Transcript entry id for history fork targeting. */
  entryId?: string;
  /** True when the corresponding transcript entry has non-text prefill content. */
  forkUnsupportedContent?: boolean;
  forkUnsupportedReason?: string;
  // Streaming-only: id of slot.serverMessages tail at the moment the
  // streaming row was created. computeMerged uses this for an id-based
  // same-turn-snapshot test instead of a timestamp window.
  serverTailIdAtStart?: string;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  activityMessages: NormalizedMessage[];
  subagentDetailMessages: Map<string, NormalizedMessage[]>;
  /** toolCallId → { subagentId, subagentType } links from bridge subagent_link frames */
  subagentLinks: Map<string, { subagentId: string; subagentType: string }>;
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  status: SessionStatus;
  fetchedAt: number;
  lastError: string | null;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    activityMessages: EMPTY,
    subagentDetailMessages: new Map(),
    subagentLinks: new Map(),
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    lastError: null,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
  };
}

function normalizeRealtimeText(value?: string): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function parseTimestampMs(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isConfirmedUserMessageDuplicate(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  if (
    realtimeMessage.kind !== 'text'
    || realtimeMessage.role !== 'user'
    || !realtimeMessage.id.startsWith('local_')
  ) {
    return false;
  }

  const realtimeText = normalizeRealtimeText(realtimeMessage.content);
  if (!realtimeText) return false;

  const realtimeTimestamp = parseTimestampMs(realtimeMessage.timestamp);

  return serverMessages.some((serverMessage) => {
    if (serverMessage.kind !== 'text' || serverMessage.role !== 'user') {
      return false;
    }

    if (normalizeRealtimeText(serverMessage.content) !== realtimeText) {
      return false;
    }

    if (realtimeTimestamp == null) {
      return true;
    }

    const serverTimestamp = parseTimestampMs(serverMessage.timestamp);
    if (serverTimestamp == null) {
      return true;
    }

    return Math.abs(serverTimestamp - realtimeTimestamp) <= 10_000;
  });
}

/**
 * The backend pushes a synthetic `interrupted` notice the moment abort fires

 * "[Request interrupted by user]" entry into the JSONL during the next user
 * turn. Once that JSONL entry is replayed via the server, drop the locally
 * pushed one to avoid stacking two dividers in the conversation.
 */
function isLocalInterruptDuplicate(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  if (
    realtimeMessage.kind !== 'interrupted'
    || !realtimeMessage.id.startsWith('local_interrupt_')
  ) {
    return false;
  }

  const realtimeTimestamp = parseTimestampMs(realtimeMessage.timestamp);

  return serverMessages.some((serverMessage) => {
    if (serverMessage.kind !== 'interrupted') return false;
    if (realtimeTimestamp == null) return true;
    const serverTimestamp = parseTimestampMs(serverMessage.timestamp);
    if (serverTimestamp == null) return true;
    // Be generous on the window — the JSONL timestamp is when the SDK wrote
    // it on the next turn, which can be many minutes after the actual abort.
    return Math.abs(serverTimestamp - realtimeTimestamp) <= 30 * 60_000;
  });
}

// NOTE: isLocalFinalizedDuplicate was removed because it prematurely filtered
// finalized thinking/text messages when ANY server data existed (even from
// prior turns). The refreshFromServer cleanup already removes non-streaming
// realtime messages once the server commits the current turn's data.

function hasEquivalentServerMessage(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  const realtimeText = normalizeRealtimeText(realtimeMessage.content);
  if (!realtimeText) return false;

  let candidates = serverMessages;
  if (realtimeMessage.serverTailIdAtStart) {
    const tailIndex = serverMessages.findIndex((message) =>
      message.id === realtimeMessage.serverTailIdAtStart
    );
    if (tailIndex < 0) return false;
    candidates = serverMessages.slice(tailIndex + 1);
  } else {
    let lastUserIndex = -1;
    for (let index = serverMessages.length - 1; index >= 0; index -= 1) {
      const message = serverMessages[index];
      if (message.kind === 'text' && message.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex >= 0) {
      candidates = serverMessages.slice(lastUserIndex + 1);
    }
  }

  return candidates.some((serverMessage) => {
    if (serverMessage.kind !== realtimeMessage.kind) return false;
    if (serverMessage.role !== realtimeMessage.role) return false;
    return normalizeRealtimeText(serverMessage.content) === realtimeText;
  });
}

function hasSameTurnServerFinalMessage(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  if (
    realtimeMessage.isFinal !== true ||
    (realtimeMessage.kind !== 'text' && realtimeMessage.kind !== 'thinking') ||
    !realtimeMessage.serverTailIdAtStart
  ) {
    return false;
  }

  const tailIndex = serverMessages.findIndex((message) => (
    message.id === realtimeMessage.serverTailIdAtStart
  ));
  if (tailIndex < 0) return false;
  const realtimeTimestamp = parseTimestampMs(realtimeMessage.timestamp);
  if (realtimeTimestamp == null) return false;
  const realtimeText = normalizeRealtimeText(realtimeMessage.content);
  if (!realtimeText) return false;

  return serverMessages.slice(tailIndex + 1).some((serverMessage) => {
    if (serverMessage.kind !== realtimeMessage.kind) return false;
    if (serverMessage.role !== realtimeMessage.role) return false;
    if (realtimeMessage.runId != null && serverMessage.runId != null && serverMessage.runId !== realtimeMessage.runId) {
      return false;
    }
    const serverTimestamp = parseTimestampMs(serverMessage.timestamp);
    if (serverTimestamp == null) return false;
    if (serverTimestamp < realtimeTimestamp) return false;
    return normalizeRealtimeText(serverMessage.content) === realtimeText;
  });
}

export function shouldKeepRealtimeAfterServerRefresh(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  if (realtimeMessage.id.startsWith('__streaming_')) {
    return true;
  }

  if (
    realtimeMessage.isFinal === true
    && (realtimeMessage.kind === 'text' || realtimeMessage.kind === 'thinking')
  ) {
    if (hasSameTurnServerFinalMessage(realtimeMessage, serverMessages)) {
      return false;
    }
    return !hasEquivalentServerMessage(realtimeMessage, serverMessages);
  }

  return false;
}

/**
 * Compute merged messages: server + realtime, deduped by id.
 * Server messages take priority (they're the persisted source of truth).
 * Realtime messages that aren't yet in server stay (in-flight streaming).
 */
export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return server;
  }
  if (server.length === 0) return realtime;
  const serverIds = new Set(server.map(m => m.id));
  const serverToolIds = new Set(
    server.filter(m => m.kind === 'tool_use' && m.toolId).map(m => m.toolId!)
  );
  const extra = realtime.filter((message) => {
    if (serverIds.has(message.id)) return false;
    if (isConfirmedUserMessageDuplicate(message, server)) return false;
    if (isLocalInterruptDuplicate(message, server)) return false;
    if (hasSameTurnServerFinalMessage(message, server)) return false;
    // Dedup tool_use by toolId (invocation ID) — the message envelope ID
    // may differ between WebSocket replay and server-persisted copy, but
    // the underlying tool invocation is the same.
    if (message.kind === 'tool_use' && message.toolId && serverToolIds.has(message.toolId)) return false;
    return true;
  });
  if (extra.length === 0) return server;

  // Structural dedup: if there's an active __streaming_ message in extras
  // AND the server's last message is an assistant text whose id is NEW
  // (different from the id captured when streaming started), the server
  // wrote a mid-stream snapshot of the in-progress turn. Drop the server
  // snapshot in favor of the live streaming version.
  //
  // We compare ids (not timestamps) so the test is immune to NTP drift /
  // burst-turn scenarios where the previous turn's assistant message
  // finished writing within milliseconds of the next turn's first
  // stream_delta — a timestamp window can't distinguish those cases,
  // but an id comparison can: the previous turn's tail id was already
  // captured into `serverTailIdAtStart`, so a `lastServer.id ===
  // streamMsg.serverTailIdAtStart` match means "still the same tail
  // that was there at turn start" → don't dedup.
  const streamIdx = extra.findIndex(m => m.id.startsWith('__streaming_'));
  if (streamIdx >= 0 && server.length > 0) {
    const lastServer = server[server.length - 1];
    const streamMsg = extra[streamIdx];
    const isAssistantText = lastServer.kind === 'text' && lastServer.role === 'assistant';
    const tailIdChanged = streamMsg.serverTailIdAtStart !== undefined
      && lastServer.id !== streamMsg.serverTailIdAtStart;
    if (isAssistantText && tailIdChanged) {
      return [...server.slice(0, -1), ...extra];
    }
  }

  const result = [...server, ...extra];
  return result;
}

function getUpsertKey(message: NormalizedMessage): string {
  if ((message.kind === 'tool_use' || message.kind === 'tool_result') && message.toolId) {
    return `${message.id}::${message.kind}::${message.toolId}`;
  }
  return message.id;
}

function isCompatibleRealtimeTextRun(a: NormalizedMessage, b: NormalizedMessage): boolean {
  if (a.runId != null && b.runId != null) return a.runId === b.runId;
  const hasActiveStream = a.kind === 'stream_delta' || b.kind === 'stream_delta';
  if (!hasActiveStream) return false;
  const aTime = parseTimestampMs(a.timestamp);
  const bTime = parseTimestampMs(b.timestamp);
  if (aTime == null || bTime == null) return false;
  return Math.abs(aTime - bTime) <= 10_000;
}

function findDuplicateAssistantRealtimeTextIndex(
  messages: NormalizedMessage[],
  incoming: NormalizedMessage,
): number {
  if (incoming.kind !== 'text' || incoming.role !== 'assistant') return -1;
  const incomingText = normalizeRealtimeText(incoming.content);
  if (!incomingText) return -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const existing = messages[index];
    const isAssistantText = existing.kind === 'text' && existing.role === 'assistant';
    const isActiveAssistantStream = existing.kind === 'stream_delta' && String(existing.id || '').startsWith('__streaming_');
    if (!isAssistantText && !isActiveAssistantStream) continue;
    if (!isCompatibleRealtimeTextRun(existing, incoming)) continue;
    if (normalizeRealtimeText(existing.content) !== incomingText) continue;
    return index;
  }

  return -1;
}

export function upsertRealtimeMessages(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  if (incoming.length === 0) return existing;
  const updated = [...existing];
  const indexByKey = new Map(updated.map((message, index) => [getUpsertKey(message), index]));
  for (const message of incoming) {
    if (message.kind === 'tool_result' && message.toolId && message.resultPath) {
      const existingToolResultIndex = findLatestToolResultIndex(updated, message.toolId);
      if (existingToolResultIndex >= 0) {
        updated[existingToolResultIndex] = {
          ...updated[existingToolResultIndex],
          resultPath: message.resultPath,
        };
        continue;
      }
    }
    const duplicateAssistantTextIndex = findDuplicateAssistantRealtimeTextIndex(updated, message);
    if (duplicateAssistantTextIndex >= 0) {
      const previousKey = getUpsertKey(updated[duplicateAssistantTextIndex]);
      updated[duplicateAssistantTextIndex] = {
        ...message,
        serverTailIdAtStart: message.serverTailIdAtStart ?? updated[duplicateAssistantTextIndex].serverTailIdAtStart,
      };
      indexByKey.delete(previousKey);
      indexByKey.set(getUpsertKey(message), duplicateAssistantTextIndex);
      continue;
    }
    const key = getUpsertKey(message);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, updated.length);
      updated.push(message);
    } else {
      updated[existingIndex] = message;
    }
  }
  return updated;
}

function findLatestToolResultIndex(messages: NormalizedMessage[], toolId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind === 'tool_result' && message.toolId === toolId) {
      return index;
    }
  }
  return -1;
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

function forceRecomputeMerged(slot: SessionSlot): void {
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
}

function streamingKey(sessionId: string, runId?: string): string {
  return runId ? `${sessionId}_${runId}` : sessionId;
}

export function getFinalizedSubagentThinkingId(
  sessionId: string,
  subagentId: string,
  timestamp?: string,
): string {
  const timestampSuffix = Date.parse(String(timestamp || '')) || Date.now();
  return `subagent_thinking_${sessionId}_${subagentId}_${timestampSuffix}`;
}

/**
 * Patch a single streaming row in `slot.merged` without recomputing the full list.
 * Returns true when the merged row was updated in place.
 */
export function patchMergedStreamingMessage(
  slot: SessionSlot,
  streamId: string,
  content: string,
  msgProvider?: SessionProvider,
): boolean {
  const mergedIdx = slot.merged.findIndex((message) => message.id === streamId);
  if (mergedIdx < 0) {
    return false;
  }

  const existing = slot.merged[mergedIdx];
  if (existing.content === content && (msgProvider == null || existing.provider === msgProvider)) {
    return true;
  }

  slot.merged[mergedIdx] = {
    ...existing,
    content,
    ...(msgProvider != null ? { provider: msgProvider } : {}),
  };
  slot.merged = slot.merged.slice();
  return true;
}

type RafScheduler = {
  schedule: (sessionId: string) => void;
  cancelAll: () => void;
};

/**
 * Coalesce per-session store notifications to one React update per animation frame.
 */
export function createRafNotifyScheduler(
  isActiveSession: (sessionId: string) => boolean,
  onNotify: () => void,
  scheduleFrame: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
): RafScheduler {
  const pendingBySession = new Map<string, number>();

  return {
    schedule(sessionId: string) {
      if (!isActiveSession(sessionId)) {
        return;
      }
      if (pendingBySession.has(sessionId)) {
        return;
      }
      const handle = scheduleFrame(() => {
        if (!pendingBySession.has(sessionId)) {
          return;
        }
        pendingBySession.delete(sessionId);
        onNotify();
      });
      pendingBySession.set(sessionId, handle);
    },
    cancelAll() {
      pendingBySession.forEach((handle) => cancelFrame(handle));
      pendingBySession.clear();
    },
  };
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);
  const notifySchedulerRef = useRef<RafScheduler | null>(null);
  const getNotifyScheduler = (): RafScheduler => {
    if (notifySchedulerRef.current == null) {
      notifySchedulerRef.current = createRafNotifyScheduler(
        (sessionId) => sessionId === activeSessionIdRef.current,
        () => setTick((n) => n + 1),
      );
    }
    return notifySchedulerRef.current;
  };
  const notify = useCallback((sessionId: string) => {
    getNotifyScheduler().schedule(sessionId);
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    const changed = activeSessionIdRef.current !== sessionId;
    activeSessionIdRef.current = sessionId;
    if (changed) {
      setTick(n => n + 1);
    }
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    return store.get(sessionId)!;
  }, []);

  const has = useCallback((sessionId: string) => storeRef.current.has(sessionId), []);

  /**
   * Fetch messages from the unified endpoint and populate serverMessages.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      sessionKind?: string;
      parentSessionId?: string;
      relativeTranscriptPath?: string;
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    slot.status = 'loading';
    notify(sessionId);

    const fetchStartedAt = Date.now();

    try {
      const params = new URLSearchParams();
      if (opts.provider) params.append('provider', opts.provider);
      if (opts.projectName) params.append('projectName', opts.projectName);
      if (opts.projectPath) params.append('projectPath', opts.projectPath);
      if (opts.sessionKind) params.append('sessionKind', opts.sessionKind);
      if (opts.parentSessionId) params.append('parentSessionId', opts.parentSessionId);
      if (opts.relativeTranscriptPath) {
        params.append('relativeTranscriptPath', opts.relativeTranscriptPath);
      }
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        params.append('offset', String(opts.offset ?? 0));
      }

      const qs = params.toString();
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url, { suppressServerErrorToast: true });

      if (!response.ok) {
        const statusError = await readAgentStatusErrorFromResponse(response, {
          event: 'web_http_request_failed',
          code: 'session_messages_load_failed',
          message: `Unable to load conversation messages (HTTP ${response.status}).`,
          scope: 'session',
        });
        throw new Error(statusError.message);
      }

      const data = await response.json();
      const messages: NormalizedMessage[] = data.messages || [];

      slot.serverMessages = messages;
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + messages.length;
      slot.fetchedAt = Date.now();
      slot.status = 'idle';
      slot.lastError = null;

      // Prune realtime messages covered by server data.  Use the later of
      // fetchStartedAt and the latest server message timestamp as watermark
      // so that messages finalized DURING the fetch (race window) are also
      // pruned when the server response already includes them.
      if (slot.realtimeMessages.length > 0 && messages.length > 0) {
        const latestServerTs = messages.reduce(
          (max, m) => Math.max(max, Date.parse(m.timestamp) || 0), 0,
        );
        const watermark = Math.max(fetchStartedAt, latestServerTs);
        const serverIds = new Set(messages.map(m => m.id));
        const serverToolIds = new Set(
          messages.filter(m => m.kind === 'tool_use' && m.toolId).map(m => m.toolId!)
        );
        slot.realtimeMessages = slot.realtimeMessages.filter(m => {
          if (shouldKeepRealtimeAfterServerRefresh(m, messages)) return true;
          if (serverIds.has(m.id)) return false;
          if (m.kind === 'tool_use' && m.toolId && serverToolIds.has(m.toolId)) return false;
          return (Date.parse(m.timestamp) || 0) > watermark;
        });
      }

      recomputeMergedIfNeeded(slot);
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }

      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
      slot.status = 'error';
      slot.lastError = error instanceof Error ? error.message : 'Unknown error';
      notify(sessionId);
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      sessionKind?: string;
      parentSessionId?: string;
      relativeTranscriptPath?: string;
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    if (!slot.hasMore) return slot;

    const params = new URLSearchParams();
    if (opts.provider) params.append('provider', opts.provider);
    if (opts.projectName) params.append('projectName', opts.projectName);
    if (opts.projectPath) params.append('projectPath', opts.projectPath);
    if (opts.sessionKind) params.append('sessionKind', opts.sessionKind);
    if (opts.parentSessionId) params.append('parentSessionId', opts.parentSessionId);
    if (opts.relativeTranscriptPath) {
      params.append('relativeTranscriptPath', opts.relativeTranscriptPath);
    }
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    params.append('offset', String(slot.offset));

    const qs = params.toString();
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url, { suppressServerErrorToast: true });
      if (!response.ok) {
        const statusError = await readAgentStatusErrorFromResponse(response, {
          event: 'web_http_request_failed',
          code: 'session_messages_load_failed',
          message: `Unable to load conversation messages (HTTP ${response.status}).`,
          scope: 'session',
        });
        throw new Error(statusError.message);
      }
      const data = await response.json();
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // Prepend older messages (they're earlier in the conversation)
      slot.serverMessages = [...olderMessages, ...slot.serverMessages];
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    let updated = upsertRealtimeMessages(slot.realtimeMessages, [msg]);
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    // Skip expensive merged recomputation and React re-render for message
    // kinds that are invisible in the UI (they return null from conversion).
    // The next visible message will trigger the recompute anyway.
    const INVISIBLE_KINDS = new Set(['status', 'session_created', 'permission_cancelled', 'compact_boundary']);
    if (!INVISIBLE_KINDS.has(msg.kind)) {
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [getSlot, notify]);

  const upsertActivity = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const key = msg.activityId || msg.id;
    const existingIndex = slot.activityMessages.findIndex((activity) =>
      (activity.activityId || activity.id) === key
    );

    if (existingIndex >= 0) {
      const updated = [...slot.activityMessages];
      updated[existingIndex] = msg;
      slot.activityMessages = updated;
    } else {
      slot.activityMessages = [...slot.activityMessages, msg];
    }

    notify(sessionId);
  }, [getSlot, notify]);

  const recordSubagentLink = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const linkMessage = msg as unknown as {
      toolCallId?: string;
      subagentId?: string;
      subagentType?: string;
    };
    const toolCallId = linkMessage.toolCallId;
    const subagentId = linkMessage.subagentId;
    const subagentType = linkMessage.subagentType;
    if (toolCallId && subagentId) {
      const nextLinks = new Map(slot.subagentLinks);
      nextLinks.set(toolCallId, { subagentId, subagentType: subagentType || 'agent' });
      slot.subagentLinks = nextLinks;
      notify(sessionId);
    }
  }, [getSlot, notify]);

  const appendSubagentDetailMessage = useCallback((
    sessionId: string,
    subagentId: string,
    msg: NormalizedMessage,
  ) => {
    const slot = getSlot(sessionId);
    const current = slot.subagentDetailMessages.get(subagentId) ?? [];
    let msgToStore = msg;
    if ((msg.kind === 'tool_use' || msg.kind === 'tool_result') && msg.toolId) {
      const existing = current.find(
        (m) => m.kind === msg.kind && m.toolId === msg.toolId && m.id === msg.id,
      );
      if (!existing || existing.toolName !== msg.toolName) {
        msgToStore = { ...msg, id: `${msg.id}::${msg.kind}::${msg.toolId}::${current.length}` };
      } else {
        msgToStore = { ...msg, id: existing.id };
      }
    }
    const updated = upsertRealtimeMessages(current, [msgToStore]);
    const nextMap = new Map(slot.subagentDetailMessages);
    nextMap.set(subagentId, updated);
    slot.subagentDetailMessages = nextMap;
    notify(sessionId);
  }, [getSlot, notify]);

  const updateSubagentDetailStreaming = useCallback((
    sessionId: string,
    subagentId: string,
    delta: string,
    msgProvider: SessionProvider,
  ) => {
    if (!delta) return;
    const slot = getSlot(sessionId);
    const streamId = `__subagent_streaming_${sessionId}_${subagentId}`;
    const current = slot.subagentDetailMessages.get(subagentId) ?? [];
    const existingIndex = current.findIndex((message) => message.id === streamId);
    let updated: NormalizedMessage[];
    if (existingIndex >= 0) {
      updated = [...current];
      const existing = updated[existingIndex];
      updated[existingIndex] = {
        ...existing,
        content: `${existing.content || ''}${delta}`,
        provider: msgProvider,
      };
    } else {
      updated = [
        ...current,
        {
          id: streamId,
          sessionId,
          timestamp: new Date().toISOString(),
          provider: msgProvider,
          kind: 'stream_delta',
          role: 'assistant',
          content: delta,
          subagentId,
          isSubagentDetail: true,
        },
      ];
    }
    const nextMap = new Map(slot.subagentDetailMessages);
    nextMap.set(subagentId, updated);
    slot.subagentDetailMessages = nextMap;
    notify(sessionId);
  }, [getSlot, notify]);

  const finalizeSubagentDetailStreaming = useCallback((sessionId: string, subagentId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__subagent_streaming_${sessionId}_${subagentId}`;
    const current = slot.subagentDetailMessages.get(subagentId) ?? [];
    const existingIndex = current.findIndex((message) => message.id === streamId);
    if (existingIndex < 0) return;
    const stream = current[existingIndex];
    const updated = [...current];
    updated[existingIndex] = {
      ...stream,
      id: `subagent_text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: 'text',
      role: 'assistant',
    };
    const nextMap = new Map(slot.subagentDetailMessages);
    nextMap.set(subagentId, updated);
    slot.subagentDetailMessages = nextMap;
    notify(sessionId);
  }, [notify]);

  const updateSubagentDetailThinking = useCallback((
    sessionId: string,
    subagentId: string,
    delta: string,
    msgProvider: SessionProvider,
  ) => {
    if (!delta) return;
    const slot = getSlot(sessionId);
    const streamId = `__subagent_thinking_${sessionId}_${subagentId}`;
    const current = slot.subagentDetailMessages.get(subagentId) ?? [];
    const existingIndex = current.findIndex((message) => message.id === streamId);
    let updated: NormalizedMessage[];
    if (existingIndex >= 0) {
      updated = [...current];
      const existing = updated[existingIndex];
      updated[existingIndex] = {
        ...existing,
        content: `${existing.content || ''}${delta}`,
        provider: msgProvider,
      };
    } else {
      updated = [
        ...current,
        {
          id: streamId,
          sessionId,
          timestamp: new Date().toISOString(),
          provider: msgProvider,
          kind: 'thinking',
          role: 'assistant',
          content: delta,
          subagentId,
          isSubagentDetail: true,
        },
      ];
    }
    const nextMap = new Map(slot.subagentDetailMessages);
    nextMap.set(subagentId, updated);
    slot.subagentDetailMessages = nextMap;
    notify(sessionId);
  }, [getSlot, notify]);

  const finalizeSubagentDetailThinking = useCallback((sessionId: string, subagentId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__subagent_thinking_${sessionId}_${subagentId}`;
    const current = slot.subagentDetailMessages.get(subagentId) ?? [];
    const existingIndex = current.findIndex((message) => message.id === streamId);
    if (existingIndex < 0) return;
    const stream = current[existingIndex];
    const updated = [...current];
    updated[existingIndex] = {
      ...stream,
      id: getFinalizedSubagentThinkingId(sessionId, subagentId, stream.timestamp),
    };
    const nextMap = new Map(slot.subagentDetailMessages);
    nextMap.set(subagentId, updated);
    slot.subagentDetailMessages = nextMap;
    notify(sessionId);
  }, [notify]);

  const getSubagentDetailMessages = useCallback((
    sessionId: string,
    subagentId: string,
  ): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.subagentDetailMessages.get(subagentId) ?? [];
  }, []);

  const setActivities = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    const slot = getSlot(sessionId);
    const byKey = new Map<string, NormalizedMessage>();

    for (const msg of msgs) {
      if (msg.kind !== 'agent_activity') continue;
      byKey.set(msg.activityId || msg.id, msg);
    }

    slot.activityMessages = Array.from(byKey.values());
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    let updated = upsertRealtimeMessages(slot.realtimeMessages, msgs);
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Re-fetch serverMessages from the unified endpoint (e.g., on projects_updated).
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      sessionKind?: string;
      parentSessionId?: string;
      relativeTranscriptPath?: string;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    try {
      const params = new URLSearchParams();
      if (opts.provider) params.append('provider', opts.provider);
      if (opts.projectName) params.append('projectName', opts.projectName);
      if (opts.projectPath) params.append('projectPath', opts.projectPath);
      if (opts.sessionKind) params.append('sessionKind', opts.sessionKind);
      if (opts.parentSessionId) params.append('parentSessionId', opts.parentSessionId);
      if (opts.relativeTranscriptPath) {
        params.append('relativeTranscriptPath', opts.relativeTranscriptPath);
      }

      const qs = params.toString();
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url, { suppressServerErrorToast: true });

      if (!response.ok) {
        const statusError = await readAgentStatusErrorFromResponse(response, {
          event: 'web_http_request_failed',
          code: 'session_messages_load_failed',
          message: `Unable to refresh conversation messages (HTTP ${response.status}).`,
          scope: 'session',
        });
        throw new Error(statusError.message);
      }
      const data = await response.json();

      const incomingMessages = data.messages || [];
      // Don't overwrite existing server messages with empty response
      // (race condition: server hasn't committed yet after stop/complete).
      if (incomingMessages.length > 0 || slot.serverMessages.length === 0) {
        slot.serverMessages = incomingMessages;
      }
      slot.total = data.total ?? slot.serverMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.fetchedAt = Date.now();
      // Server is authoritative, but a post-complete refresh can race the
      // transcript writer/read path and return a non-empty yet not-quite-final
      // snapshot. Keep finalized local stream text until the server returns
      // an equivalent assistant message; otherwise the UI can show "complete"
      // while the model's visible answer disappears.
      if (slot.realtimeMessages.length > 0 && incomingMessages.length > 0) {
        slot.realtimeMessages = slot.realtimeMessages.filter((message) =>
          shouldKeepRealtimeAfterServerRefresh(message, incomingMessages)
        );
      }
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [getSlot, notify]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const slot = getSlot(sessionId);
    slot.status = status;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: SessionProvider, runId?: string) => {
    const slot = getSlot(sessionId);
    const streamId = `__streaming_${streamingKey(sessionId, runId)}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      // Subsequent delta — preserve the original turn-start timestamp so
      // computeMerged can tell which server snapshots belong to this turn.
      const existing = slot.realtimeMessages[idx];
      if (existing.content === accumulatedText && existing.provider === msgProvider) {
        return;
      }
      if (!patchMergedStreamingMessage(slot, streamId, accumulatedText, msgProvider)) {
        existing.content = accumulatedText;
        existing.provider = msgProvider;
        forceRecomputeMerged(slot);
      } else {
        existing.content = accumulatedText;
        existing.provider = msgProvider;
      }
      notify(sessionId);
      return;
    } else {
      // Record the id of server's tail message at the moment this turn
      // started streaming. computeMerged uses this for an id-based
      // dedup check that's immune to NTP drift / burst-turn time
      // windows: only delete the server tail if it's a NEW message
      // (a real mid-stream snapshot) rather than the previous turn's
      // legitimate trailing assistant message.
      const serverTailId = slot.serverMessages.length > 0
        ? slot.serverMessages[slot.serverMessages.length - 1].id
        : null;
      const msg: NormalizedMessage = {
        id: streamId,
        sessionId,
        timestamp: new Date().toISOString(),
        provider: msgProvider,
        kind: 'stream_delta',
        content: accumulatedText,
        runId,
        serverTailIdAtStart: serverTailId ?? undefined,
      };
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = useCallback((sessionId: string, runId?: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_${streamingKey(sessionId, runId)}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      const newId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: newId,
        kind: 'text',
        role: 'assistant',
        isFinal: true,
      };
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Update or create a streaming thinking message (accumulated thinking so far).
   * Mirrors updateStreaming but uses kind='thinking' and a separate well-known ID.
   */
  const updateStreamingThinking = useCallback((sessionId: string, accumulatedText: string, msgProvider: SessionProvider, runId?: string) => {
    const slot = getSlot(sessionId);
    const streamId = `__streaming_thinking_${streamingKey(sessionId, runId)}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const existing = slot.realtimeMessages[idx];
      if (existing.content === accumulatedText && existing.provider === msgProvider) {
        return;
      }
      // FIX: patch merged BEFORE mutating existing (same fix as updateStreaming)
      if (!patchMergedStreamingMessage(slot, streamId, accumulatedText, msgProvider)) {
        existing.content = accumulatedText;
        existing.provider = msgProvider;
        forceRecomputeMerged(slot);
      } else {
        existing.content = accumulatedText;
        existing.provider = msgProvider;
      }
      notify(sessionId);
      return;
    } else {
      const serverTailId = slot.serverMessages.length > 0
        ? slot.serverMessages[slot.serverMessages.length - 1].id
        : null;
      const msg: NormalizedMessage = {
        id: streamId,
        sessionId,
        timestamp: new Date().toISOString(),
        provider: msgProvider,
        kind: 'thinking',
        content: accumulatedText,
        runId,
        serverTailIdAtStart: serverTailId ?? undefined,
      };
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming thinking: replace the well-known streaming thinking ID
   * with a unique ID so subsequent thinking blocks don't overwrite it.
   */
  const finalizeStreamingThinking = useCallback((sessionId: string, runId?: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_thinking_${streamingKey(sessionId, runId)}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      const newId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: newId,
        isFinal: true,
      };
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  const clearAssistantRealtime = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const nextRealtime = slot.realtimeMessages.filter((message) => {
      if (message.kind === 'thinking' || message.kind === 'stream_delta' || message.kind === 'stream_end') {
        return false;
      }
      return !(message.kind === 'text' && message.role === 'assistant');
    });
    if (nextRealtime.length === slot.realtimeMessages.length) return;
    slot.realtimeMessages = nextRealtime;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [notify]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? [];
  }, []);

  const getActivityMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.activityMessages ?? [];
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    upsertActivity,
    setActivities,
    appendRealtimeBatch,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    updateStreamingThinking,
    finalizeStreamingThinking,
    clearRealtime,
    clearAssistantRealtime,
    getMessages,
    getActivityMessages,
    getSubagentDetailMessages,
    getSessionSlot,
    recordSubagentLink,
    appendSubagentDetailMessage,
    updateSubagentDetailStreaming,
    finalizeSubagentDetailStreaming,
    updateSubagentDetailThinking,
    finalizeSubagentDetailThinking,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, upsertActivity, setActivities, appendRealtimeBatch, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    updateStreamingThinking, finalizeStreamingThinking,
    clearRealtime, clearAssistantRealtime, getMessages, getActivityMessages, getSubagentDetailMessages, getSessionSlot,
    recordSubagentLink, appendSubagentDetailMessage, updateSubagentDetailStreaming,
    finalizeSubagentDetailStreaming, updateSubagentDetailThinking, finalizeSubagentDetailThinking,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
