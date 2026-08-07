import { describe, expect, it, vi } from 'vitest';
import type { SessionProvider } from '../types/app';
import {
  getActiveTurnReplayMessagesToApply,
  getDuplicateAssistantStreamTextState,
  isSessionForActiveView,
} from '../components/chat/hooks/useChatRealtimeHandlers';
import {
  computeMerged,
  cancelRunningAgentActivities,
  createRafNotifyScheduler,
  getFinalizedSubagentThinkingId,
  getUnpersistedRealtimeTurnMessages,
  isRealtimeMessageRepresentedOnServer,
  patchMergedStreamingMessage,
  shouldKeepRealtimeAfterServerRefresh,
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
    _serverRequestGeneration: 0,
    _serverAppliedGeneration: 0,
    _serverLoadingGeneration: null,
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

describe('isSessionForActiveView', () => {
  it('does not accept the previously loaded session while a new session is selected', () => {
    // On a session switch `currentSessionId` can still be A for one render,
    // while the UI is already showing B. A status from A must not update B's
    // live compaction progress.
    expect(isSessionForActiveView('web:session-a', 'web:session-b')).toBe(false);
    expect(isSessionForActiveView('web:session-b', 'web:session-b')).toBe(true);
  });

  it('accepts a pending new-session view when no saved session is selected', () => {
    expect(isSessionForActiveView('web:new-session', 'web:new-session')).toBe(true);
  });
});

describe('cancelRunningAgentActivities', () => {
  it('marks only unfinished agent activities as cancelled after a confirmed abort', () => {
    const running = {
      id: 'subagent-running',
      sessionId: 'cron:task-1',
      timestamp: '2026-08-05T00:00:00.000Z',
      provider: PROVIDER,
      kind: 'agent_activity' as const,
      activityId: 'subagent:running',
      state: 'running',
    };
    const completed = {
      ...running,
      id: 'subagent-completed',
      activityId: 'subagent:completed',
      state: 'completed',
      endedAt: '2026-08-05T00:01:00.000Z',
    };
    const text = textMessage('assistant-text', 'Already written', '2026-08-05T00:00:30.000Z');
    const endedAt = '2026-08-05T00:02:00.000Z';

    const activities = cancelRunningAgentActivities([running, completed, text], endedAt);

    expect(activities[0]).toMatchObject({ state: 'cancelled', endedAt });
    expect(activities[1]).toBe(completed);
    expect(activities[2]).toBe(text);
  });

  it('keeps the same array when there are no running agent activities', () => {
    const activities: NormalizedMessage[] = [{
      id: 'subagent-completed',
      sessionId: 'cron:task-1',
      timestamp: '2026-08-05T00:00:00.000Z',
      provider: PROVIDER,
      kind: 'agent_activity',
      activityId: 'subagent:completed',
      state: 'completed',
    }];

    expect(cancelRunningAgentActivities(activities, '2026-08-05T00:02:00.000Z')).toBe(activities);
  });
});

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

  it('keeps identical assistant text from different persisted turns', () => {
    const server = [
      textMessage('server-turn-1', 'Same answer', '2026-05-28T00:00:01.000Z', {
        runId: 'run-1',
      }),
    ];
    const realtime = [
      textMessage('realtime-turn-2', 'Same answer', '2026-05-28T00:00:02.000Z', {
        runId: 'run-2',
        isFinal: true,
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'server-turn-1',
      'realtime-turn-2',
    ]);
  });
});

describe('turn-scoped server reconciliation', () => {
  const artifact = {
    id: 'artifact-1',
    name: 'report.xlsx',
    path: 'report.xlsx',
    operation: 'created' as const,
    source: 'workspace_diff' as const,
    status: 'complete' as const,
    size: 42,
    sha256: 'a'.repeat(64),
    createdAt: '2026-05-28T00:00:02.000Z',
  };

  it('keeps current-turn final text and artifacts when the first refresh is stale', () => {
    const realtime = [
      textMessage('local-final', 'Finished.', '2026-05-28T00:00:01.000Z', {
        runId: 'run-current',
        isFinal: true,
      }),
      {
        id: 'local-artifacts',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:02.000Z',
        provider: PROVIDER,
        kind: 'file_artifacts' as const,
        runId: 'run-current',
        artifacts: [artifact],
      },
    ];
    const staleServer = [
      textMessage('previous-answer', 'Previous.', '2026-05-27T23:59:00.000Z', {
        runId: 'run-previous',
      }),
    ];

    expect(getUnpersistedRealtimeTurnMessages(realtime, staleServer, 'run-current')).toHaveLength(2);
    expect(computeMerged(staleServer, realtime).map((message) => message.id)).toEqual([
      'previous-answer',
      'local-final',
      'local-artifacts',
    ]);
  });

  it('recognizes persisted text and artifact frames by turn identity', () => {
    const localText = textMessage('local-final', 'Finished.', '2026-05-28T00:00:01.000Z', {
      runId: 'run-current',
      isFinal: true,
    });
    const localArtifacts: NormalizedMessage = {
      id: 'local-artifacts',
      sessionId: 'web:s_test',
      timestamp: '2026-05-28T00:00:02.000Z',
      provider: PROVIDER,
      kind: 'file_artifacts',
      runId: 'run-current',
      artifacts: [artifact],
    };
    const server = [
      textMessage('persisted-final', 'Finished.', '2026-05-28T00:00:03.000Z', {
        turnId: 'run-current',
        runId: 'run-current',
      }),
      {
        ...localArtifacts,
        id: 'persisted-artifacts',
        turnId: 'run-current',
      },
    ];

    expect(isRealtimeMessageRepresentedOnServer(localText, server)).toBe(true);
    expect(isRealtimeMessageRepresentedOnServer(localArtifacts, server)).toBe(true);
    expect(getUnpersistedRealtimeTurnMessages(
      [localText, localArtifacts],
      server,
      'run-current',
    )).toEqual([]);
  });

  it('keeps a live compact boundary until history persists it, then dedupes it', () => {
    const liveBoundary: NormalizedMessage = {
      id: 'live-compact',
      sessionId: 'web:s_test',
      timestamp: '2026-05-28T00:00:02.000Z',
      provider: PROVIDER,
      kind: 'compact_boundary',
      runId: 'run-current',
      trigger: 'auto',
      preTokens: 120,
      postTokens: 40,
      messagesSummarized: 2,
      compactStage: 'summary',
    };
    const staleServer = [
      textMessage('previous-answer', 'Previous.', '2026-05-28T00:00:00.000Z', {
        runId: 'run-previous',
      }),
    ];
    const persistedBoundary: NormalizedMessage = {
      ...liveBoundary,
      id: 'persisted-compact',
      turnId: 'run-current',
    };

    expect(shouldKeepRealtimeAfterServerRefresh(liveBoundary, staleServer)).toBe(true);
    expect(computeMerged(staleServer, [liveBoundary]).map((message) => message.id)).toEqual([
      'previous-answer',
      'live-compact',
    ]);

    expect(isRealtimeMessageRepresentedOnServer(liveBoundary, [persistedBoundary])).toBe(true);
    expect(shouldKeepRealtimeAfterServerRefresh(liveBoundary, [persistedBoundary])).toBe(false);
    expect(computeMerged([persistedBoundary], [liveBoundary]).map((message) => message.id)).toEqual([
      'persisted-compact',
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

describe('getActiveTurnReplayMessagesToApply', () => {
  it('skips active-turn stream replay already represented by finalized realtime text', () => {
    const activeTurnMessages = [
      {
        id: 'delta-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:02.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'Hello ',
        runId: 'run-1',
      },
      {
        id: 'delta-2',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:03.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'world',
        runId: 'run-1',
      },
      {
        id: 'end-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:04.000Z',
        provider: PROVIDER,
        kind: 'stream_end' as const,
        runId: 'run-1',
      },
    ];

    const messagesToApply = getActiveTurnReplayMessagesToApply(activeTurnMessages, {
      realtimeMessages: [
        textMessage('local-final', 'Hello world', '2026-05-28T00:00:01.000Z', {
          isFinal: true,
          runId: 'run-1',
        }),
      ],
    });

    expect(messagesToApply).toEqual([]);
  });

  it('keeps non-volatile replay frames while dropping duplicate stream blocks', () => {
    const activeTurnMessages = [
      {
        id: 'delta-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:02.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'Already rendered',
        runId: 'run-1',
      },
      {
        id: 'end-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:03.000Z',
        provider: PROVIDER,
        kind: 'stream_end' as const,
        runId: 'run-1',
      },
      {
        id: 'tool-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:04.000Z',
        provider: PROVIDER,
        kind: 'tool_use' as const,
        toolId: 'tool-call-1',
        toolName: 'Read',
      },
    ];

    const messagesToApply = getActiveTurnReplayMessagesToApply(activeTurnMessages, {
      realtimeMessages: [
        textMessage('local-final', 'Already rendered', '2026-05-28T00:00:01.000Z', {
          isFinal: true,
          runId: 'run-1',
        }),
      ],
    });

    expect(messagesToApply.map((message) => message.id)).toEqual(['tool-1']);
  });

  it('drops only the rendered stream block when a later block is new', () => {
    const activeTurnMessages = [
      {
        id: 'delta-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:02.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'First block',
        runId: 'run-1',
      },
      {
        id: 'end-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:03.000Z',
        provider: PROVIDER,
        kind: 'stream_end' as const,
        runId: 'run-1',
      },
      {
        id: 'delta-2',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:04.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'Second block',
        runId: 'run-1',
      },
    ];

    const messagesToApply = getActiveTurnReplayMessagesToApply(activeTurnMessages, {
      realtimeMessages: [
        textMessage('local-final', 'First block', '2026-05-28T00:00:01.000Z', {
          isFinal: true,
          runId: 'run-1',
        }),
      ],
    });

    expect(messagesToApply.map((message) => message.id)).toEqual(['delta-2']);
  });

  it('does not drop same-content stream blocks from a different known run', () => {
    const activeTurnMessages = [
      {
        id: 'delta-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:02.000Z',
        provider: PROVIDER,
        kind: 'stream_delta' as const,
        content: 'Same text',
        runId: 'run-2',
      },
    ];

    const messagesToApply = getActiveTurnReplayMessagesToApply(activeTurnMessages, {
      realtimeMessages: [
        textMessage('local-final', 'Same text', '2026-05-28T00:00:01.000Z', {
          isFinal: true,
          runId: 'run-1',
        }),
      ],
    });

    expect(messagesToApply.map((message) => message.id)).toEqual(['delta-1']);
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
    const activeSessionId: string | null = 'web:s_1';
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
