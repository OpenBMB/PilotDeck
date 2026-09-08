import { useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react';
import type { ChatMessage } from '../chat/types/types';
import { normalizedToChatMessages } from '../chat/hooks/useChatMessages';
import type { NormalizedMessage, SessionStore } from '../../stores/useSessionStore';
import type { SessionRequestParams } from '../../types/app';
import { authenticatedFetch } from '../../utils/api';

const EMPTY_NORMALIZED_MESSAGES: NormalizedMessage[] = [];

interface SubagentMessagesResult {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
}

function isPilotDeckForkDirective(message: ChatMessage): boolean {
  if (typeof message.content !== 'string') return false;
  return message.content.includes('<pilotdeck-fork>') &&
    message.content.includes('Directive:');
}

function isPilotDeckForkPlaceholder(message: ChatMessage): boolean {
  const content = typeof message.content === 'string' ? message.content : '';
  const toolResultContent = typeof message.toolResult?.content === 'string'
    ? message.toolResult.content
    : '';
  return `${content}\n${toolResultContent}`.includes('<pilotdeck-fork-placeholder>');
}

function filterSubagentDetailMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) =>
    !isPilotDeckForkDirective(message) &&
    !isPilotDeckForkPlaceholder(message)
  );
}

function normalizeSubagentDetailContainers(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.isSubagentContainer && !message.subagentId) {
      return { ...message, isSubagentContainer: false, subagentState: undefined };
    }
    return message;
  });
}

export function mergeSubagentDetailMessages(
  snapshotMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  useSnapshotOnly: boolean,
): NormalizedMessage[] {
  if (useSnapshotOnly && snapshotMessages.length > 0) {
    return snapshotMessages;
  }

  if (snapshotMessages.length === 0) {
    return realtimeMessages;
  }

  const merged = [...snapshotMessages];
  const seenIds = new Set(snapshotMessages.map((message) => message.id));
  const snapshotToolIds = new Set(
    snapshotMessages.filter(m => m.kind === 'tool_use' && m.toolId).map(m => m.toolId!),
  );
  const latestSnapshotFinalTimestamp = snapshotMessages.reduce<number | null>((latest, message) => {
    if (
      (message.kind !== 'text' || message.role === 'user') &&
      message.kind !== 'thinking'
    ) return latest;
    const parsed = Date.parse(String(message.timestamp || ''));
    if (!Number.isFinite(parsed)) return latest;
    return latest == null ? parsed : Math.max(latest, parsed);
  }, null);
  for (const message of realtimeMessages) {
    if (seenIds.has(message.id)) continue;
    if (message.kind === 'tool_use' && message.toolId && snapshotToolIds.has(message.toolId)) continue;
    if (message.kind === 'tool_result' && message.toolId && snapshotToolIds.has(message.toolId)) continue;
    if (
      ((message.kind === 'text' && message.role !== 'user') || message.kind === 'thinking') &&
      latestSnapshotFinalTimestamp != null &&
      !String(message.id || '').startsWith('__subagent_thinking_')
    ) {
      const parsed = Date.parse(String(message.timestamp || ''));
      if (!Number.isFinite(parsed) || parsed <= latestSnapshotFinalTimestamp) continue;
    }
    seenIds.add(message.id);
    merged.push(message);
  }
  return merged;
}

// Snapshot IDs differ from stream IDs. Within one child transcript, preserve
// identity by ID/tool ID first, then by unambiguous content and occurrence order.
export function inheritSubagentRenderKeys(previous: NormalizedMessage[], next: NormalizedMessage[]): NormalizedMessage[] {
  const kind = (message: NormalizedMessage) => message.kind === 'stream_delta' ? 'text' : message.kind;
  const role = (message: NormalizedMessage) => kind(message) === 'text' ? message.role || 'assistant' : null;
  const compatible = (a: NormalizedMessage, b: NormalizedMessage) => kind(a) === kind(b) && role(a) === role(b);
  const signature = (message: NormalizedMessage) => JSON.stringify([kind(message), role(message), message.content]);
  const key = (candidate: NormalizedMessage) => candidate.renderKey || candidate.id;
  const exactMatches = next.map((message) => previous.find((candidate) => compatible(candidate, message)
    && (candidate.id === message.id || (message.toolId && candidate.toolId === message.toolId))));
  // Reserve strong identities before matching by content, regardless of order.
  const used = new Set(exactMatches.flatMap((match) => match ? [key(match)] : []));
  return next.map((message, index) => {
    const candidates = previous.filter((candidate) => compatible(candidate, message) && !used.has(key(candidate)));
    let match = exactMatches[index];
    if (!match && message.content) {
      const sameContent = (candidate: NormalizedMessage) => signature(candidate) === signature(message);
      // Different occurrence counts are ambiguous; do not transfer one row's
      // expansion/reading state to a different repeated thought or answer.
      if (previous.filter(sameContent).length === next.filter(sameContent).length) {
        match = candidates.find(sameContent);
      }
    }
    const renderKey = match ? key(match) : message.renderKey || message.id;
    used.add(renderKey);
    return renderKey === message.renderKey ? message : { ...message, renderKey };
  });
}

export function useSubagentMessages(
  sessionId: string | null,
  subagentId: string | null,
  projectPath?: string,
  sessionStore?: SessionStore,
  refreshKey?: string,
  sessionRequestParams: SessionRequestParams = {},
): SubagentMessagesResult {
  const scope = JSON.stringify([sessionId, subagentId, projectPath, sessionRequestParams.sessionKind,
    sessionRequestParams.parentSessionId, sessionRequestParams.relativeTranscriptPath]);
  const [snapshot, setSnapshot] = useState<{ scope: string; refreshKey?: string; messages: NormalizedMessage[] } | null>(null);
  const [request, setRequest] = useState<{ scope: string; isLoading: boolean; error: string | null } | null>(null);
  const previousRef = useRef<{ scope: string; messages: NormalizedMessage[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { sessionKind, parentSessionId, relativeTranscriptPath } = sessionRequestParams;
  const realtimeMessages = sessionId && subagentId
    ? sessionStore?.getSubagentDetailMessages?.(sessionId, subagentId) ?? EMPTY_NORMALIZED_MESSAGES
    : EMPTY_NORMALIZED_MESSAGES;
  const normalized = useMemo(() => {
    const snapshotMessages = snapshot?.scope === scope ? snapshot.messages : EMPTY_NORMALIZED_MESSAGES;
    // A status change starts a refresh. Until THAT snapshot arrives, retain the
    // live tail instead of switching back to an older incomplete snapshot.
    const useSnapshotOnly = snapshot?.scope === scope && snapshot.refreshKey === refreshKey
      && (refreshKey === 'completed' || refreshKey === 'failed');
    const merged = mergeSubagentDetailMessages(snapshotMessages, realtimeMessages, useSnapshotOnly);
    return inheritSubagentRenderKeys(previousRef.current?.scope === scope ? previousRef.current.messages : [], merged);
  }, [snapshot, realtimeMessages, scope, refreshKey]);
  useLayoutEffect(() => { previousRef.current = { scope, messages: normalized }; }, [scope, normalized]);
  const messages = useMemo(() => normalizeSubagentDetailContainers(
    filterSubagentDetailMessages(normalizedToChatMessages(normalized)),
  ), [normalized]);

  useEffect(() => {
    if (!sessionId || !subagentId) {
      setSnapshot(null);
      setRequest(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRequest({ scope, isLoading: true, error: null });

    const params = new URLSearchParams();
    if (projectPath) params.set('projectPath', projectPath);
    if (sessionKind) params.set('sessionKind', sessionKind);
    if (parentSessionId) params.set('parentSessionId', parentSessionId);
    if (relativeTranscriptPath) params.set('relativeTranscriptPath', relativeTranscriptPath);
    const query = params.toString();
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(subagentId)}/messages${query ? `?${query}` : ''}`;

    authenticatedFetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        const normalized = Array.isArray(data.messages) ? data.messages : [];
        setSnapshot({ scope, refreshKey, messages: normalized });
        setRequest({ scope, isLoading: false, error: null });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setRequest({ scope, isLoading: false, error: err instanceof Error ? err.message : String(err) });
      });

    return () => controller.abort();
  }, [sessionId, subagentId, projectPath, refreshKey, sessionKind, parentSessionId, relativeTranscriptPath, scope]);

  return { messages, isLoading: request?.scope === scope && request.isLoading, error: request?.scope === scope ? request.error : null };
}
