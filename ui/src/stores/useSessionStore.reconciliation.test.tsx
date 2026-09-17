import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';
import { getIntrinsicMessageKey } from '../components/chat/utils/messageKeys';
import { authenticatedFetch } from '../utils/api';
import { computeMerged, normalizeCompactionMessage, upsertRealtimeMessages, useSessionStore, type NormalizedMessage } from './useSessionStore';

vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn(), readAgentStatusErrorFromResponse: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const session = 'session';
const run = 'run';
const msg = (id: string, kind: NormalizedMessage['kind'], content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id, sessionId: session, timestamp: '2026-09-10T10:00:00.000Z', provider: 'pilotdeck', kind, content, runId: run, ...extra,
});
const user = msg('user', 'text', 'Question', { role: 'user' });
const tool = msg('tool', 'tool_result', 'output', { toolId: 'read-settings' });
const snapshot = msg('snapshot', 'thinking', 'The file shows');
async function refresh(store: ReturnType<typeof useSessionStore>, messages: NormalizedMessage[]) {
  vi.mocked(authenticatedFetch).mockResolvedValueOnce({ ok: true, json: async () => ({ messages, total: messages.length, hasMore: false }) } as Response);
  await act(async () => { await store.refreshFromServer(session, { provider: 'pilotdeck' }); });
}

describe('live and persisted message reconciliation', () => {
  it('updates compression in place and ignores replayed starts after completion', async () => {
    const { result } = renderHook(() => useSessionStore());
    await refresh(result.current, [user]);
    const started = msg('start-event', 'status', '', { compactProgress: {
      compaction_id: 'compact-lifecycle', level: 1, stage: 'summary', label: 'Summarizing', state: 'running',
    } });
    act(() => result.current.appendRealtime(session, started));
    const initial = result.current.getMessages(session)[1];
    expect(initial).toMatchObject({ kind: 'compact_boundary', compactState: 'running' });
    const answer = msg('answer', 'text', 'After compression', { role: 'assistant' });
    act(() => {
      result.current.appendRealtime(session, answer);
      result.current.appendRealtime(session, msg('completion-event', 'compact_boundary', '', {
        compactionId: 'compact-lifecycle', postTokens: 20, timestamp: '2026-09-10T10:00:30Z',
      }));
      result.current.appendRealtime(session, started);
    });
    expect(result.current.getMessages(session).map(m => m.id)).toEqual([user.id, initial.id, answer.id]);
    expect(result.current.getMessages(session)[1]).toMatchObject({ compactState: 'completed', postTokens: 20, timestamp: initial.timestamp });
    const stableKey = normalizedToChatMessages(result.current.getMessages(session))[1].renderKey;
    await refresh(result.current, [user, msg('history-compact', 'compact_boundary', '', { compactionId: 'compact-lifecycle', postTokens: 20 }), answer]);
    expect(result.current.getMessages(session)).toHaveLength(3);
    expect(normalizedToChatMessages(result.current.getMessages(session))[1].renderKey).toBe(stableKey);
  });

  it('handles a completed-only replay and distinguishes separate compressions', () => {
    const done = msg('done', 'compact_boundary', '', { compactionId: 'c1' });
    const next = msg('next', 'compact_boundary', '', { compactionId: 'c2', compactState: 'running' });
    expect(upsertRealtimeMessages([], [done, done, next]).map(m => m.compactState)).toEqual(['completed', 'running']);
    expect(normalizeCompactionMessage({ ...done, compactMetadata: { status: 'failed' } }).compactState).toBe('failed');
  });

  it('stops unfinished compression with the run and accepts a late completion', () => {
    const { result } = renderHook(() => useSessionStore());
    const compact = msg('compact', 'compact_boundary', '', { compactionId: 'c1', compactState: 'running' });
    act(() => {
      result.current.appendRealtime(session, compact);
      result.current.cancelRunningActivities(session);
    });
    expect(result.current.getMessages(session)[0].compactState).toBe('cancelled');
    act(() => result.current.appendRealtime(session, { ...compact, compactState: 'completed' }));
    expect(result.current.getMessages(session)).toHaveLength(1);
    expect(result.current.getMessages(session)[0].compactState).toBe('completed');
  });
  it('reconciles a queued image echo and its answer with the attachment-bearing transcript', async () => {
    const { result } = renderHook(() => useSessionStore());
    const prior = msg('previous-answer', 'text', 'Previous answer', { role: 'assistant', runId: 'previous' });
    await refresh(result.current, [prior]);
    const echo = msg('text_gateway_uuid', 'text', 'Describe the image', { role: 'user', queueItemId: 'queue-1' });
    act(() => {
      result.current.appendRealtime(session, echo);
      result.current.updateStreamingThinking(session, 'Two shapes.', 'pilotdeck', run);
      result.current.finalizeStreamingThinking(session, run);
      result.current.updateStreaming(session, 'Red square and blue circle.', 'pilotdeck', run);
      result.current.finalizeStreaming(session, run);
    });
    const persistedUser = msg('persisted-image-user', 'text', 'Describe the image\n\n[Registered attachment files in this session:]\n- shapes.png: /tmp/shapes.png\nThese are path references for reuse. If an image/PDF is already visible in this turn, do not call read_file just to view it.', { role: 'user', images: ['data:image/png;base64,test'] });
    const persistedThought = msg('persisted-thought', 'thinking', 'Two shapes.');
    const persistedAnswer = msg('persisted-answer', 'text', 'Red square and blue circle.', { role: 'assistant' });
    const history = [prior, persistedUser, persistedThought, persistedAnswer];
    await refresh(result.current, history);
    expect(result.current.getMessages(session).map(m => m.id)).toEqual(history.map(m => m.id));
    expect(result.current.getMessages(session).filter(m => m.role === 'user')[0].images).toHaveLength(1);
  });

  it('does not treat out-of-band status rows from another turn as transcript boundaries', () => {
    const status = msg('next-turn-status', 'status', '', { runId: 'next-turn' });
    const active = msg('__streaming_thinking_session_run', 'thinking', 'The file shows the answer.', {
      serverTailIdAtStart: null, streamBoundaryAtStart: user,
    });
    expect(computeMerged([user, status, snapshot], [active]).filter(m => m.kind === 'thinking').map(m => m.content))
      .toEqual(['The file shows the answer.']);
  });

  it('keeps a steer distinct from the queued input in the same run', () => {
    const queued = msg('text_queue', 'text', 'Question', { role: 'user', queueItemId: 'queue-1' });
    const steer = msg('text_steer', 'text', 'Question', { role: 'user', queueItemId: 'queue-2', isSteer: true });
    expect(upsertRealtimeMessages([queued], [steer])).toHaveLength(2);
  });

  it('keeps reconciled thinking in the snapshot position before later assistant text', () => {
    const answer = msg('answer', 'text', 'The answer.', { role: 'assistant' });
    const active = msg('__streaming_thinking_session_run', 'thinking', 'The file shows the answer.', { serverTailIdAtStart: 'user' });
    expect(computeMerged([user, snapshot, answer], [active]).map(m => m.id)).toEqual(['user', active.id, 'answer']);
  });

  it('recognizes a persisted tool boundary equal to the captured server tail', async () => {
    const { result } = renderHook(() => useSessionStore());
    // HTTP history arrives before the buffered WebSocket tool event.
    await refresh(result.current, [user, tool]);
    act(() => {
      result.current.appendRealtime(session, tool);
      result.current.updateStreamingThinking(session, 'The file shows the answer.', 'pilotdeck', run);
    });
    expect(result.current.getSessionSlot(session)?.realtimeMessages.at(-1)).toMatchObject({ serverTailIdAtStart: 'tool', toolBoundaryIdAtStart: 'read-settings' });
    await refresh(result.current, [user, tool, snapshot]);
    expect(result.current.getMessages(session).filter(m => m.kind === 'thinking').map(m => m.content)).toEqual(['The file shows the answer.']);
  });

  it('does not bring a reconciled prefix back when thinking finalizes', async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreamingThinking(session, 'The file shows the answer.', 'pilotdeck', run));
    await refresh(result.current, [snapshot]);
    expect(result.current.getMessages(session).filter(m => m.kind === 'thinking')).toHaveLength(1);
    act(() => result.current.finalizeStreamingThinking(session, run));
    expect(result.current.getMessages(session).filter(m => m.kind === 'thinking').map(m => m.content)).toEqual(['The file shows the answer.']);
  });

  it('preserves an independent post-tool block whose entire current text equals the previous block', () => {
    const old = msg('old', 'thinking', 'Let me check.');
    const active = msg('__streaming_thinking_session_run', 'thinking', 'Let me check.', { serverTailIdAtStart: 'tool', toolBoundaryIdAtStart: 'read-settings' });
    expect(computeMerged([user, old, tool], [active]).map(m => m.id)).toEqual(['user', 'old', 'tool', active.id]);
  });

  it('does not delete another turn answer when initial history arrives after an empty-history text stream', async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreaming(session, 'New answer', 'pilotdeck', 'new-run'));
    const oldAnswer = msg('old-answer', 'text', 'Previous answer', { role: 'assistant', runId: 'old-run' });
    await refresh(result.current, [oldAnswer]);
    expect(result.current.getMessages(session).map(m => m.content)).toEqual(['Previous answer', 'New answer']);
  });

  it.each(['before', 'after'])('keeps an unpersisted compaction between confirmed text across refresh (%s anchor)', async (side) => {
    const { result } = renderHook(() => useSessionStore());
    const before = msg('before', 'text', 'Before compact', { role: 'assistant' });
    const after = msg('after', 'text', 'After compact', { role: 'assistant' });
    const compact = msg('compact', 'compact_boundary', '', { compactionId: 'c1' });
    act(() => result.current.appendRealtimeBatch(session, side === 'before' ? [before, compact] : [compact, after]));
    await refresh(result.current, [before, after]);
    expect(result.current.getMessages(session).map(m => m.id)).toEqual(['before', 'compact', 'after']);
    await refresh(result.current, [before, after]);
    expect(result.current.getMessages(session).map(m => m.id)).toEqual(['before', 'compact', 'after']);
    await refresh(result.current, [before, { ...compact, id: 'persisted-compact' }, after]);
    expect(result.current.getMessages(session).map(m => m.id)).toEqual(['before', 'persisted-compact', 'after']);
  });

  it.each([false, true])('keeps a late-persisted compaction after its captured history tail (batch=%s)', async batch => {
    const { result } = renderHook(() => useSessionStore());
    const before = msg('before', 'text', 'Before compact', { role: 'assistant' });
    const after = msg('after', 'text', 'After compact', { role: 'assistant' });
    await refresh(result.current, [before]);
    act(() => {
      const compact = msg('compact', 'compact_boundary', '', { compactionId: 'c1' });
      if (batch) result.current.appendRealtimeBatch(session, [compact]);
      else result.current.appendRealtime(session, compact);
    });
    await refresh(result.current, [before, after]);
    expect(result.current.getMessages(session).map(m => m.id)).toEqual(['before', 'compact', 'after']);
  });

  it('preserves independent identical reasoning across a compaction with stale history', async () => {
    const { result } = renderHook(() => useSessionStore());
    await refresh(result.current, [user]);
    act(() => {
      result.current.updateStreamingThinking(session, 'Let me check.', 'pilotdeck', run);
      result.current.finalizeStreamingThinking(session, run);
      result.current.appendRealtime(session, msg('compact', 'compact_boundary', '', { compactionId: 'c1' }));
      result.current.updateStreamingThinking(session, 'Let me check.', 'pilotdeck', run);
    });
    const first = msg('first', 'thinking', 'Let me check.');
    await refresh(result.current, [user, first]);
    expect(result.current.getMessages(session).map(m => m.kind)).toEqual(['text', 'thinking', 'compact_boundary', 'thinking']);
    await refresh(result.current, [user, first, msg('persisted-compact', 'compact_boundary', '', { compactionId: 'c1' }), msg('second', 'thinking', 'Let me check.')]);
    expect(result.current.getMessages(session).map(m => m.id)).toEqual(['user', 'first', 'persisted-compact', 'second']);
  });

  it('keeps a finalized thinking snapshot before the tool even when history has advanced', async () => {
    const { result } = renderHook(() => useSessionStore());
    await refresh(result.current, [user]);
    act(() => {
      result.current.updateStreamingThinking(session, 'The file shows the answer.', 'pilotdeck', run);
      result.current.finalizeStreamingThinking(session, run);
      result.current.appendRealtime(session, tool);
    });
    await refresh(result.current, [user, snapshot, tool]);
    expect(result.current.getMessages(session).map(m => m.kind)).toEqual(['text', 'thinking', 'tool_result']);
    expect(result.current.getMessages(session)[1].content).toBe('The file shows the answer.');
  });

  it('keeps text snapshots after thinking and preserves the render key while the server leads', async () => {
    const { result } = renderHook(() => useSessionStore());
    await refresh(result.current, [user]);
    act(() => result.current.updateStreaming(session, 'Answer', 'pilotdeck', run));
    const live = normalizedToChatMessages(result.current.getMessages(session)).at(-1)!;
    await refresh(result.current, [user, snapshot, msg('answer', 'text', 'Answer with details', { role: 'assistant' })]);
    const confirmed = normalizedToChatMessages(result.current.getMessages(session)).at(-1)!;
    expect(getIntrinsicMessageKey(confirmed)).toBe(getIntrinsicMessageKey(live));
    act(() => result.current.updateStreaming(session, 'Answer with details and more', 'pilotdeck', run));
    expect(result.current.getMessages(session).map(m => m.kind)).toEqual(['text', 'thinking', 'stream_delta']);
    expect(result.current.getMessages(session).at(-1)?.content).toBe('Answer with details and more');
  });

  it.each([false, true])('shows one user bubble when optimistic send and WebSocket echo arrive (reverse=%s)', async reverse => {
    const { result } = renderHook(() => useSessionStore());
    const local = msg('local_client', 'text', 'Describe this image', { role: 'user', images: ['data:image/png;base64,preview'] });
    const echo = { ...local, id: 'local_ws_user', images: undefined };
    act(() => result.current.appendRealtimeBatch(session, reverse ? [echo, local] : [local, echo]));
    expect(result.current.getMessages(session)).toHaveLength(1);
    expect(result.current.getMessages(session)[0].images).toEqual(local.images);
    const persisted = { ...echo, id: 'persisted-user' };
    await refresh(result.current, [persisted]);
    expect(result.current.getMessages(session)).toHaveLength(1);
    expect(result.current.getMessages(session)[0].images).toEqual(local.images);
    await refresh(result.current, [persisted]);
    expect(result.current.getMessages(session)[0].images).toEqual(local.images);
  });

  it('does not combine distinct sends or same-run applied guidance', () => {
    const local = msg('local_first', 'text', 'Continue', { role: 'user' });
    const other = { ...local, id: 'local_second', runId: 'other-run' };
    const guidance = { ...local, id: 'applied-guidance' };
    expect(upsertRealtimeMessages([local], [other, guidance])).toHaveLength(3);
  });

  it('keeps identical assistant text on opposite sides of compaction', () => {
    const before = msg('before', 'text', 'Continue', { role: 'assistant' });
    const compact = msg('compact', 'compact_boundary', '', { compactionId: 'c1' });
    expect(upsertRealtimeMessages([before, compact], [{ ...before, id: 'after' }]).map(m => m.id))
      .toEqual(['before', 'compact', 'after']);
  });

  it('matches thinking after its image query is persisted with a different text projection', async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(session, { ...user, id: 'local_user', images: ['preview'] });
      result.current.updateStreamingThinking(session, 'The file shows the answer.', 'pilotdeck', run);
    });
    await refresh(result.current, [{ ...user, content: 'Question\n[Registered attachment files in this session: image.png]' }, snapshot]);
    expect(result.current.getMessages(session).map(m => m.kind)).toEqual(['text', 'thinking']);
    expect(result.current.getMessages(session)[0].images).toEqual(['preview']);
  });

  it('reconciles the current turn when initial history includes earlier turns', async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.updateStreamingThinking(session, 'The file shows the answer.', 'pilotdeck', run));
    const old = msg('old', 'text', 'Earlier answer', { role: 'assistant', runId: 'old-run' });
    await refresh(result.current, [old, user, snapshot]);
    expect(result.current.getMessages(session).map(m => m.content)).toEqual(['Earlier answer', 'Question', 'The file shows the answer.']);
  });

  it('retains compaction anchors when streaming overlaps the initial history request', async () => {
    const { result } = renderHook(() => useSessionStore());
    let resolveFetch!: (response: Response) => void;
    vi.mocked(authenticatedFetch).mockReturnValueOnce(new Promise(resolve => { resolveFetch = resolve; }));
    let request!: ReturnType<typeof result.current.fetchFromServer>;
    act(() => { request = result.current.fetchFromServer(session, { provider: 'pilotdeck' }); });
    const before = msg('before', 'text', 'Before compact', { role: 'assistant' });
    const after = msg('after', 'text', 'After compact', { role: 'assistant' });
    act(() => result.current.appendRealtimeBatch(session, [before, msg('compact', 'compact_boundary', '', { compactionId: 'c1' }), after]));
    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ messages: [before, after] }) } as Response);
      await request;
    });
    expect(result.current.getMessages(session).map(m => m.id)).toEqual(['before', 'compact', 'after']);
    await refresh(result.current, [before, after]);
    expect(result.current.getMessages(session).map(m => m.id)).toEqual(['before', 'compact', 'after']);
  });
});
