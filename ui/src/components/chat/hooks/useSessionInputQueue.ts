import { useCallback, useEffect, useRef, useState } from 'react';
import type { InputQueueState, PreparedQueuedInput } from '../types/queuedInput';

type QueueOperationResult = {
  ok: boolean;
  error?: string;
  state?: InputQueueState;
};

type PendingOperation = {
  resolve: (result: QueueOperationResult) => void;
  timeoutId: number;
  sessionId: string;
};

const EMPTY_QUEUE: InputQueueState = {
  sessionId: '',
  revision: 0,
  paused: false,
  items: [],
};

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `queue-op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useSessionInputQueue({
  sessionId,
  projectPath,
  ws,
  sendMessage,
  subscribe,
}: {
  sessionId: string | null;
  projectPath?: string;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  subscribe?: (handler: (message: any) => void) => () => void;
}) {
  const [queueState, setQueueState] = useState<InputQueueState>(EMPTY_QUEUE);
  const pendingRef = useRef(new Map<string, PendingOperation>());

  useEffect(() => {
    if (!subscribe) return undefined;
    return subscribe((message) => {
      if (message?.type === 'input-queue-state' && message.sessionId === sessionId) {
        setQueueState((previous) => (
          message.revision >= previous.revision ? message as InputQueueState : previous
        ));
        return;
      }
      if (message?.type !== 'input-queue-operation-result' || typeof message.requestId !== 'string') return;
      const pending = pendingRef.current.get(message.requestId);
      if (!pending) return;
      if (message.sessionId !== pending.sessionId) return;
      pendingRef.current.delete(message.requestId);
      window.clearTimeout(pending.timeoutId);
      if (message.state && message.state.sessionId === sessionId) {
        setQueueState((previous) => (
          message.state.revision >= previous.revision
            ? message.state as InputQueueState
            : previous
        ));
      }
      pending.resolve({ ok: message.ok === true, error: message.error, state: message.state });
    });
  }, [sessionId, subscribe]);

  useEffect(() => {
    setQueueState({ ...EMPTY_QUEUE, sessionId: sessionId || '' });
    if (!sessionId || ws?.readyState !== WebSocket.OPEN) return;
    sendMessage({
      type: 'get-input-queue',
      sessionId,
      options: projectPath ? { projectPath, cwd: projectPath } : {},
    });
  }, [projectPath, sendMessage, sessionId, ws?.readyState]);

  useEffect(() => () => {
    for (const [requestId, pending] of pendingRef.current) {
      if (pending.sessionId !== sessionId) continue;
      window.clearTimeout(pending.timeoutId);
      pending.resolve({ ok: false, error: 'Queue operation was cancelled.' });
      pendingRef.current.delete(requestId);
    }
  }, [sessionId]);

  const request = useCallback((message: Record<string, unknown>): Promise<QueueOperationResult> => {
    if (!sessionId) return Promise.resolve({ ok: false, error: 'No active session.' });
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: 'PilotDeck is disconnected.' });
    }
    const requestId = createRequestId();
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        pendingRef.current.delete(requestId);
        resolve({ ok: false, error: 'Queue operation timed out.' });
      }, 10_000);
      pendingRef.current.set(requestId, { resolve, timeoutId, sessionId });
      try {
        sendMessage({ ...message, requestId, sessionId, provider: 'pilotdeck' });
      } catch (error) {
        window.clearTimeout(timeoutId);
        pendingRef.current.delete(requestId);
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to send the queue operation.',
        });
      }
    });
  }, [sendMessage, sessionId, ws]);

  const enqueue = useCallback(
    (item: PreparedQueuedInput) => request({ type: 'queue-input', item }),
    [request],
  );
  const remove = useCallback(
    (itemId: string) => request({ type: 'delete-queued-input', itemId }),
    [request],
  );
  const moveToFront = useCallback(
    (itemId: string) => request({ type: 'move-queued-input', itemId }),
    [request],
  );
  const steer = useCallback(
    (itemId: string) => request({ type: 'steer-queued-input', itemId }),
    [request],
  );
  const resume = useCallback(
    () => request({ type: 'resume-input-queue' }),
    [request],
  );

  return { queueState, enqueue, remove, moveToFront, steer, resume };
}
