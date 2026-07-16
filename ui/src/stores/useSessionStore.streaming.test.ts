import { describe, expect, it, vi } from 'vitest';
import type { SessionProvider } from '../types/app';
import { getDuplicateAssistantStreamTextState } from '../components/chat/hooks/useChatRealtimeHandlers';
import {
  computeMerged,
  createRafNotifyScheduler,
  getFinalizedSubagentThinkingId,
  patchMergedStreamingMessage,
  upsertRealtimeMessages,
  type NormalizedMessage,
  type SessionSlot,
} from './useSessionStore';

const PROVIDER = 'pilotdeck' as SessionProvider;

function makeSlot(overrides: Partial<SessionSlot> = {}): SessionSlot {
  return {
    serverMessages: [],
    realtimeMessages: [],
    activityMessages: [],
    subagentDetailMessages: new Map(),
    subagentLinks: new Map(),
    merged: [],
    _lastServerRef: [],
    _lastRealtimeRef: [],
    status: 'streaming',
    fetchedAt: 0,
    lastError: null,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    ...overrides,
  };
}

function textMessage(
  id: string,
  content: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id,
    sessionId: 'web:s_test',
    timestamp,
    provider: PROVIDER,
    kind: 'text',
    role: 'assistant',
    content,
    ...overrides,
  };
}

function streamingMessage(sessionId: string, content: string): NormalizedMessage {
  return {
    id: `__streaming_${sessionId}`,
    sessionId,
    timestamp: '2026-05-28T00:00:00.000Z',
    provider: PROVIDER,
    kind: 'stream_delta',
    content,
  };
}

describe('patchMergedStreamingMessage', () => {
  it('updates merged content without recomputing from store inputs', () => {
    const sessionId = 'web:s_test';
    const streamId = `__streaming_${sessionId}`;
    const merged = [streamingMessage(sessionId, 'hello')];
    const slot = makeSlot({
      realtimeMessages: [streamingMessage(sessionId, 'hello')],
      merged,
      _lastRealtimeRef: [streamingMessage(sessionId, 'hello')],
    });

    const realtimeBefore = slot.realtimeMessages;
    const patched = patchMergedStreamingMessage(slot, streamId, 'hello world', PROVIDER);

    expect(patched).toBe(true);
    expect(slot.realtimeMessages).toBe(realtimeBefore);
    expect(slot.merged[0]?.content).toBe('hello world');
  });

  it('returns false when the streaming row is not yet in merged', () => {
    const slot = makeSlot();
    expect(patchMergedStreamingMessage(slot, '__streaming_missing', 'text', PROVIDER)).toBe(false);
  });

  it('skips object replacement when content is unchanged', () => {
    const sessionId = 'web:s_test';
    const streamId = `__streaming_${sessionId}`;
    const row = streamingMessage(sessionId, 'same');
    const slot = makeSlot({ merged: [row] });
    const rowBefore = slot.merged[0];

    patchMergedStreamingMessage(slot, streamId, 'same', PROVIDER);

    expect(slot.merged[0]).toBe(rowBefore);
  });
});

describe('computeMerged', () => {
  it('keeps finalized realtime assistant text until an equivalent same-turn server text is persisted', () => {
    const server = [
      textMessage('tail-before-turn', 'Previous answer', '2026-05-28T00:00:00.000Z'),
      textMessage('persisted-answer', 'Persisted answer', '2026-05-28T00:00:02.000Z'),
    ];
    const realtime = [
      textMessage('text-local-final', 'Realtime answer', '2026-05-28T00:00:01.000Z', {
        isFinal: true,
        serverTailIdAtStart: 'tail-before-turn',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'tail-before-turn',
      'persisted-answer',
      'text-local-final',
    ]);
  });

  it('drops finalized realtime assistant text once equivalent same-turn text is persisted', () => {
    const server = [
      textMessage('tail-before-turn', 'Previous answer', '2026-05-28T00:00:00.000Z'),
      textMessage('persisted-answer', 'Realtime answer', '2026-05-28T00:00:02.000Z'),
    ];
    const realtime = [
      textMessage('text-local-final', 'Realtime answer', '2026-05-28T00:00:01.000Z', {
        isFinal: true,
        serverTailIdAtStart: 'tail-before-turn',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'tail-before-turn',
      'persisted-answer',
    ]);
  });

  it('keeps later finalized realtime assistant text when only an earlier same-turn text is persisted', () => {
    const server = [
      textMessage('tail-before-turn', 'Previous answer', '2026-05-28T00:00:00.000Z'),
      textMessage('persisted-earlier-answer', 'First same-turn answer', '2026-05-28T00:00:02.000Z'),
    ];
    const realtime = [
      textMessage('text-local-second-final', 'Second same-turn answer', '2026-05-28T00:00:03.000Z', {
        isFinal: true,
        serverTailIdAtStart: 'tail-before-turn',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'tail-before-turn',
      'persisted-earlier-answer',
      'text-local-second-final',
    ]);
  });
});

describe('getDuplicateAssistantStreamTextState', () => {
  it('detects standalone assistant text duplicated by an active stream row', () => {
    const incoming = textMessage('server-text', 'Hello from stream', '2026-05-28T00:00:02.000Z', {
      runId: 'run-1',
    });
    const realtime = [
      {
        id: '__streaming_web:s_test_run-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:01.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'Hello\nfrom stream',
        runId: 'run-1',
      },
    ];

    expect(getDuplicateAssistantStreamTextState(incoming, realtime)).toEqual({
      isDuplicate: true,
      hasActiveStream: true,
      activeStreamRunId: 'run-1',
    });
  });

  it('returns null activeStreamRunId for duplicate active stream without runId', () => {
    const incoming = textMessage('server-text', 'Hello from stream', '2026-05-28T00:00:02.000Z', {
      runId: 'run-1',
    });
    const realtime = [
      {
        id: '__streaming_web:s_test',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:01.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'Hello from stream',
      },
    ];

    expect(getDuplicateAssistantStreamTextState(incoming, realtime)).toEqual({
      isDuplicate: true,
      hasActiveStream: true,
      activeStreamRunId: null,
    });
  });

  it('does not dedupe assistant text against a different run stream', () => {
    const incoming = textMessage('server-text', 'Hello from stream', '2026-05-28T00:00:02.000Z', {
      runId: 'run-2',
    });
    const realtime = [
      {
        id: '__streaming_web:s_test_run-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:01.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'Hello from stream',
        runId: 'run-1',
      },
    ];

    expect(getDuplicateAssistantStreamTextState(incoming, realtime)).toEqual({
      isDuplicate: false,
      hasActiveStream: false,
    });
  });

  it('does not dedupe finalized assistant text without runId in the handler helper', () => {
    const incoming = textMessage('incoming-text', 'Same answer', '2026-05-28T00:00:10.000Z');
    const realtime = [
      textMessage('existing-text', 'Same answer', '2026-05-28T00:00:01.000Z'),
    ];

    expect(getDuplicateAssistantStreamTextState(incoming, realtime)).toEqual({
      isDuplicate: false,
      hasActiveStream: false,
    });
  });

  it('does not dedupe active stream text without runId outside the short time window', () => {
    const incoming = textMessage('incoming-text', 'Same answer', '2026-05-28T00:01:00.000Z');
    const realtime = [
      {
        id: '__streaming_web:s_test',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:01.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'Same answer',
      },
    ];

    expect(getDuplicateAssistantStreamTextState(incoming, realtime)).toEqual({
      isDuplicate: false,
      hasActiveStream: false,
    });
  });
});

describe('upsertRealtimeMessages', () => {
  it('replaces an active stream row with duplicate standalone assistant text', () => {
    const existing: NormalizedMessage[] = [
      {
        id: '__streaming_web:s_test_run-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:01.000Z',
        provider: PROVIDER,
        kind: 'stream_delta',
        content: 'Final answer',
        runId: 'run-1',
        serverTailIdAtStart: 'tail-before-turn',
      },
    ];
    const incoming = textMessage('server-text', 'Final answer', '2026-05-28T00:00:02.000Z', {
      runId: 'run-1',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe('server-text');
    expect(updated[0]?.kind).toBe('text');
    expect(updated[0]?.serverTailIdAtStart).toBe('tail-before-turn');
  });

  it('dedupes duplicate standalone assistant text in the same run', () => {
    const existing = [
      textMessage('local-text', 'Final answer', '2026-05-28T00:00:01.000Z', { runId: 'run-1' }),
    ];
    const incoming = textMessage('server-text', 'Final answer', '2026-05-28T00:00:02.000Z', {
      runId: 'run-1',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe('server-text');
  });

  it('keeps identical assistant text from different runs', () => {
    const existing = [
      textMessage('run-1-text', 'Same answer', '2026-05-28T00:00:01.000Z', { runId: 'run-1' }),
    ];
    const incoming = textMessage('run-2-text', 'Same answer', '2026-05-28T00:01:01.000Z', {
      runId: 'run-2',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated.map((message) => message.id)).toEqual(['run-1-text', 'run-2-text']);
  });

  it('keeps duplicate finalized assistant text when runId is missing', () => {
    const existing = [
      textMessage('first-text', 'Same answer', '2026-05-28T00:00:01.000Z'),
    ];
    const incoming = textMessage('second-text', 'Same answer', '2026-05-28T00:00:02.000Z');

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated.map((message) => message.id)).toEqual(['first-text', 'second-text']);
  });

  it('keeps duplicate active stream text without runId outside the short time window', () => {
    const existing: NormalizedMessage[] = [
      {
        id: '__streaming_web:s_test',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:01.000Z',
        provider: PROVIDER,
        kind: 'stream_delta',
        content: 'Same answer',
      },
    ];
    const incoming = textMessage('incoming-text', 'Same answer', '2026-05-28T00:01:00.000Z');

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated.map((message) => message.id)).toEqual(['__streaming_web:s_test', 'incoming-text']);
  });
});

describe('createRafNotifyScheduler', () => {
  it('coalesces multiple schedules for the same session into one frame callback', () => {
    const frames: Array<() => void> = [];
    let activeSessionId: string | null = 'web:s_1';
    let notifyCount = 0;

    const scheduler = createRafNotifyScheduler(
      (sessionId) => sessionId === activeSessionId,
      () => {
        notifyCount += 1;
      },
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      () => {},
    );

    scheduler.schedule('web:s_1');
    scheduler.schedule('web:s_1');
    scheduler.schedule('web:s_1');

    expect(frames).toHaveLength(1);

    frames[0]?.();
    expect(notifyCount).toBe(1);

    scheduler.schedule('web:s_1');
    expect(frames).toHaveLength(2);
  });

  it('does not schedule when the session is not active', () => {
    const frames: Array<() => void> = [];
    const onNotify = vi.fn();

    const scheduler = createRafNotifyScheduler(
      () => false,
      onNotify,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      () => {},
    );

    scheduler.schedule('web:s_1');
    expect(frames).toHaveLength(0);
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('cancelAll clears pending frame callbacks', () => {
    const frames: Array<() => void> = [];
    const cancelled: number[] = [];
    const onNotify = vi.fn();

    const scheduler = createRafNotifyScheduler(
      () => true,
      onNotify,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      (handle) => {
        cancelled.push(handle);
      },
    );

    scheduler.schedule('web:s_1');
    scheduler.cancelAll();

    expect(cancelled).toEqual([1]);
    frames[0]?.();
    expect(onNotify).not.toHaveBeenCalled();
  });
});

describe('subagent detail thinking ids', () => {
  it('finalizes subagent thinking with timestamp-based id instead of local sequence', () => {
    const id = getFinalizedSubagentThinkingId(
      'session-1',
      'subagent-1',
      '2026-05-28T00:00:03.000Z',
    );

    expect(id).toBe(`subagent_thinking_session-1_subagent-1_${Date.parse('2026-05-28T00:00:03.000Z')}`);
    expect(id).not.toBe('subagent_thinking_session-1_subagent-1_0');
  });
});
