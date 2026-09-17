import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSession } from '../types/app';
import { authenticatedFetch } from '../utils/api';
import { useChatRealtimeHandlers } from '../components/chat/hooks/useChatRealtimeHandlers';
import { buildSessionStatusRequest, resetSessionStatusProtocolForTests } from '../components/chat/sessionStatusProtocol';
import { useSessionStore, type NormalizedMessage } from './useSessionStore';

const mocks = vi.hoisted(() => ({ listener: null as null | ((message: unknown) => void) }));
vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn(), readAgentStatusErrorFromResponse: vi.fn() }));
vi.mock('../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({
    sendMessage: vi.fn(),
    subscribe: (listener: (message: unknown) => void) => {
      mocks.listener = listener;
      return () => {};
    },
  }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => resetSessionStatusProtocolForTests());
const sid = 'review-session';
const run = 'review-run';
const msg = (id: string, kind: NormalizedMessage['kind'], content = '', extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id, kind, content, sessionId: sid, runId: run, provider: 'pilotdeck', timestamp: '2026-09-14T00:00:00Z', ...extra,
});
const user = msg('user', 'text', 'Question', { role: 'user' });
async function refresh(store: ReturnType<typeof useSessionStore>, messages: NormalizedMessage[]) {
  vi.mocked(authenticatedFetch).mockResolvedValueOnce({
    ok: true, json: async () => ({ messages, total: messages.length, hasMore: false }),
  } as Response);
  await act(async () => { await store.refreshFromServer(sid, { provider: 'pilotdeck' }); });
}
function setup() {
  const { result } = renderHook(() => useSessionStore());
  const store = result.current;
  const noop = () => {};
  renderHook(() => useChatRealtimeHandlers({
    provider: 'pilotdeck',
    selectedProject: { name: 'review', fullPath: '/tmp' } as Project,
    selectedSession: { id: sid } as ProjectSession,
    currentSessionId: sid, activeRunId: run,
    setCurrentSessionId: noop, setIsLoading: noop, setSessionRuntimeState: noop,
    setActiveRunId: noop, setCanAbortSession: noop, setIsAborting: noop,
    setClaudeStatus: noop, setPilotDeckStatus: noop, setTokenBudget: noop,
    setPendingPermissionRequests: noop, pendingViewSessionRef: { current: null }, sessionStore: store,
  }));
  return store;
}
function replay(messages: NormalizedMessage[]) {
  const request = buildSessionStatusRequest({
    sessionId: sid, provider: 'pilotdeck', expectedActiveRunId: run, includeActiveTurnMessages: true,
  });
  mocks.listener?.({ ...request, type: 'session-status', isProcessing: true, activeRunId: run, activeTurnMessages: messages });
}
const start = msg('compact-start', 'status', 'compacting', {
  compactProgress: { compaction_id: 'c1', state: 'running', level: 1, stage: 'summary', label: 'Summarizing' },
});
const done = msg('compact-done', 'compact_boundary', '', { compactionId: 'c1' });

describe('reviewed stream reconciliation races', () => {
  it.each([false, true])('accumulates interleaved channels without splitting Markdown (text first=%s)', async (textFirst) => {
    const store = setup();
    await refresh(store, [user]);
    const frames = [
      msg('think-1', 'thinking', 'Let me', { blockId: 'r1:thinking:0' }),
      msg('text-1', 'stream_delta', '**Hello', { blockId: 'r1:text:0' }),
      msg('think-2', 'thinking', ' check.', { blockId: 'r1:thinking:0' }),
      msg('text-2', 'stream_delta', ' world**', { blockId: 'r1:text:0' }),
    ];
    if (textFirst) [frames[0], frames[1]] = [frames[1], frames[0]];
    act(() => frames.forEach(frame => mocks.listener?.(frame)));
    const contents = () => store.getMessages(sid).filter(m => m.blockId).map(m => m.content);
    expect(contents().sort()).toEqual(['**Hello world**', 'Let me check.']);
    act(() => { replay(frames); mocks.listener?.(msg('end', 'stream_end')); });
    expect(contents().sort()).toEqual(['**Hello world**', 'Let me check.']);
    const history = [user,
      msg('thought', 'thinking', 'Let me check.', { blockId: 'r1:thinking:0' }),
      msg('answer', 'text', '**Hello world**', { role: 'assistant', blockId: 'r1:text:0' }),
    ];
    await refresh(store, history);
    expect(store.getMessages(sid).map(m => m.id)).toEqual(history.map(m => m.id));
    const reloaded = setup();
    await refresh(reloaded, history);
    act(() => replay(frames));
    expect(reloaded.getSessionSlot(sid)?.realtimeMessages.filter(m => m.blockId)).toEqual([]);
  });

  it.each(['replay', 'direct', 'status-only'])('ignores an old compact start before stream side effects (%s)', async (delivery) => {
    const store = setup();
    await refresh(store, [user]);
    act(() => {
      mocks.listener?.(start);
      mocks.listener?.(done);
      mocks.listener?.(msg('delta-1', 'stream_delta', 'Hello'));
      if (delivery === 'replay') replay([start, done, msg('delta-1', 'stream_delta', 'Hello')]);
      if (delivery === 'direct') { mocks.listener?.(start); mocks.listener?.(done); }
      if (delivery === 'status-only') {
        const request = buildSessionStatusRequest({ sessionId: sid, provider: 'pilotdeck', expectedActiveRunId: run, includeActiveTurnMessages: true });
        mocks.listener?.({ ...request, type: 'session-status', activeRunId: run, status: { compactProgress: start.compactProgress } });
      }
      mocks.listener?.(msg('delta-2', 'stream_delta', ' world'));
      mocks.listener?.(msg('end', 'stream_end'));
    });
    await refresh(store, [user, done, msg('answer', 'text', 'Hello world', { role: 'assistant' })]);
    expect(store.getMessages(sid).filter(m => m.kind === 'text' && m.role === 'assistant').map(m => m.content)).toEqual(['Hello world']);
  });

  it('applies a replayed completion to an existing running compact', () => {
    const store = setup();
    act(() => { mocks.listener?.(start); replay([start, done]); });
    expect(store.getMessages(sid).filter(m => m.kind === 'compact_boundary')).toEqual([
      expect.objectContaining({ compactionId: 'c1', compactState: 'completed' }),
    ]);
  });

  it.each([undefined, 'response-1:thinking:0'])('reconciles history arriving before its thinking delta (block ID %s)', async (blockId) => {
    const store = setup();
    const thought = msg('persisted-thought', 'thinking', 'The same thought', { blockId });
    await refresh(store, [user, thought]);
    act(() => {
      mocks.listener?.(msg('delta', 'thinking', 'The same thought', { blockId }));
      mocks.listener?.(msg('end', 'stream_end'));
    });
    await refresh(store, [user, thought]);
    expect(store.getMessages(sid).filter(m => m.kind === 'thinking').map(m => m.content)).toEqual(['The same thought']);
  });

  it.each(['Second reasoning', 'First reasoning'])('reconciles legacy continuation blocks with reasoning: %s', async (second) => {
    const { result } = renderHook(() => useSessionStore());
    const store = result.current;
    await refresh(store, [user]);
    act(() => {
      store.updateStreamingThinking(sid, 'First reasoning', 'pilotdeck', run);
      store.finalizeStreamingThinking(sid, run);
      store.updateStreaming(sid, 'First truncated answer', 'pilotdeck', run);
      store.finalizeStreaming(sid, run);
      store.appendRealtime(sid, msg('request-2', 'status', '', { text: 'model_request_started' }));
      store.updateStreamingThinking(sid, second, 'pilotdeck', run);
      store.finalizeStreamingThinking(sid, run);
      store.updateStreaming(sid, 'Continued answer', 'pilotdeck', run);
      store.finalizeStreaming(sid, run);
    });
    const history = [user, msg('thought-1', 'thinking', 'First reasoning'),
      msg('answer-1', 'text', 'First truncated answer', { role: 'assistant' }),
      msg('thought-2', 'thinking', second), msg('answer-2', 'text', 'Continued answer', { role: 'assistant' })];
    await refresh(store, history);
    expect(store.getMessages(sid).map(m => m.id)).toEqual(history.map(m => m.id));
  });

  it('keeps identical responses distinct without a tool/compact/stream-end boundary', async () => {
    const store = setup();
    await refresh(store, [user]);
    const history = [user];
    act(() => {
      for (const responseId of ['r1', 'r2']) {
        const thought = msg(`${responseId}-thought`, 'thinking', 'Same thought', { blockId: `${responseId}:thinking:0` });
        const answer = msg(`${responseId}-answer`, 'text', 'Same answer', { role: 'assistant', blockId: `${responseId}:text:0` });
        mocks.listener?.(thought);
        mocks.listener?.({ ...answer, kind: 'stream_delta' });
        history.push(thought, answer);
      }
      mocks.listener?.(msg('end', 'stream_end'));
    });
    expect(store.getMessages(sid).filter(m => m.blockId).map(m => m.content)).toEqual(['Same thought', 'Same answer', 'Same thought', 'Same answer']);
    await refresh(store, history);
    expect(store.getMessages(sid).map(m => m.id)).toEqual(history.map(m => m.id));
    act(() => replay(history.slice(1)));
    expect(store.getMessages(sid).map(m => m.id)).toEqual(history.map(m => m.id));
  });

  it('updates a known block in place despite a later history tail and a shorter snapshot', async () => {
    const store = setup();
    const thought = msg('thought', 'thinking', 'Reason', { blockId: 'r1:thinking:0' });
    const answer = msg('answer', 'text', 'Answer', { role: 'assistant', blockId: 'r1:text:0' });
    await refresh(store, [user, thought, answer]);
    act(() => mocks.listener?.({ ...thought, id: 'delta', content: 'Reason with details' }));
    expect(store.getMessages(sid).map(m => m.content)).toEqual(['Question', 'Reason with details', 'Answer']);
    act(() => mocks.listener?.(msg('end', 'stream_end')));
    await refresh(store, [user, { ...thought, content: 'Reason with details' }, answer]);
    expect(store.getMessages(sid).map(m => m.id)).toEqual(['user', 'thought', 'answer']);
  });
});
