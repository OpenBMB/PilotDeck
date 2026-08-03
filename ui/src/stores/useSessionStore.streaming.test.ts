import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionProvider } from '../types/app';
import {
  getActiveTurnReplaySignature,
  getActiveTurnReplayMessagesToApply,
  getDuplicateAssistantStreamTextState,
  isThinkingReplayAlreadyRendered,
} from '../components/chat/hooks/useChatRealtimeHandlers';
import {
  computeMerged,
  createRafNotifyScheduler,
  finalizeStreamingRealtimeMessages,
  getFinalizedSubagentThinkingId,
  patchMergedStreamingMessage,
  pruneRealtimeMessagesAfterServerRefresh,
  upsertRealtimeMessages,
  useSessionStore,
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

function thinkingMessage(
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
    kind: 'thinking',
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

function streamingRunMessage(sessionId: string, runId: string, content: string): NormalizedMessage {
  return {
    id: `__streaming_${sessionId}_${runId}`,
    sessionId,
    timestamp: '2026-05-28T00:00:01.000Z',
    provider: PROVIDER,
    kind: 'stream_delta',
    content,
    runId,
    serverTailIdAtStart: 'tail-before-turn',
  };
}

function toolUseMessage(id: string, timestamp = '2026-05-28T00:00:02.000Z'): NormalizedMessage {
  return {
    id,
    sessionId: 'web:s_test',
    timestamp,
    provider: PROVIDER,
    kind: 'tool_use',
    toolName: 'Read',
    toolId: id,
    toolInput: { file_path: '/repo/src/App.tsx' },
  };
}

function toolResultMessage(
  id: string,
  toolId = 'tool-read-1',
  timestamp = '2026-05-28T00:00:04.000Z',
): NormalizedMessage {
  return {
    id,
    sessionId: 'web:s_test',
    timestamp,
    provider: PROVIDER,
    kind: 'tool_result',
    toolName: 'Read',
    toolId,
    toolResult: { content: 'ok', isError: false },
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

describe('useSessionStore compact boundaries', () => {
  it('recomputes merged messages immediately for realtime compact boundaries', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.appendRealtime('web:s_test', {
        id: 'compact-1',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:01.000Z',
        provider: PROVIDER,
        kind: 'compact_boundary',
        text: 'Context compacted',
        preTokens: 120,
      });
    });

    const messages = result.current.getMessages('web:s_test');

    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe('compact_boundary');
    expect(result.current.getSessionSlot('web:s_test')?.realtimeMessages).toHaveLength(1);
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

  it('places live thinking before server-side assistant snapshots in the same turn', () => {
    const server = [
      textMessage('tail-before-turn', 'Previous answer', '2026-05-28T00:00:00.000Z'),
      textMessage('persisted-answer', 'I inspected the file.', '2026-05-28T00:00:02.000Z'),
      toolUseMessage('tool-read-1', '2026-05-28T00:00:03.000Z'),
    ];
    const realtime = [
      thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-a', 'Plan next step', '2026-05-28T00:00:04.000Z', {
        runId: 'run-1',
        thinkingBlockId: 'block-a',
        thinkingBlockSeq: 1,
        serverTailIdAtStart: 'tail-before-turn',
      }),
      thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-b', 'Then inspect the result', '2026-05-28T00:00:05.000Z', {
        runId: 'run-1',
        thinkingBlockId: 'block-b',
        thinkingBlockSeq: 2,
        serverTailIdAtStart: 'tail-before-turn',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'tail-before-turn',
      '__streaming_thinking_web:s_test_run-1_id_block-a',
      '__streaming_thinking_web:s_test_run-1_id_block-b',
      'persisted-answer',
      'tool-read-1',
    ]);
  });

  it('keeps a later live thinking block after its server-side tool result', () => {
    const server = [
      textMessage('tail-before-turn', 'Previous answer', '2026-05-28T00:00:00.000Z'),
      textMessage('persisted-answer', 'I inspected the file.', '2026-05-28T00:00:02.000Z'),
      toolUseMessage('tool-read-1', '2026-05-28T00:00:03.000Z'),
      toolResultMessage('tool-result-1', 'tool-read-1', '2026-05-28T00:00:04.000Z'),
    ];
    const realtime = [
      toolResultMessage('tool-result-1', 'tool-read-1', '2026-05-28T00:00:04.000Z'),
      thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-b', 'Decide next step', '2026-05-28T00:00:05.000Z', {
        runId: 'run-1',
        thinkingBlockId: 'block-b',
        thinkingBlockSeq: 2,
        serverTailIdAtStart: 'tail-before-turn',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'tail-before-turn',
      'persisted-answer',
      'tool-read-1',
      'tool-result-1',
      '__streaming_thinking_web:s_test_run-1_id_block-b',
    ]);
  });

  it('places thinking before an assistant snapshot used as the live content anchor', () => {
    const server = [
      textMessage('tail-before-turn', 'Previous answer', '2026-05-28T00:00:00.000Z'),
      textMessage('assistant-snapshot', 'Visible answer', '2026-05-28T00:00:02.000Z'),
    ];
    const realtime = [
      thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-a', 'Plan first', '2026-05-28T00:00:03.000Z', {
        runId: 'run-1',
        thinkingBlockId: 'block-a',
        thinkingBlockSeq: 1,
        serverTailIdAtStart: 'assistant-snapshot',
      }),
      textMessage('text-final', 'Visible answer', '2026-05-28T00:00:04.000Z', {
        isFinal: true,
        runId: 'run-1',
        serverTailIdAtStart: 'assistant-snapshot',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'tail-before-turn',
      '__streaming_thinking_web:s_test_run-1_id_block-a',
      'assistant-snapshot',
    ]);
  });
});

describe('finalizeStreamingRealtimeMessages', () => {
  it('drops duplicate streaming thinking that is already finalized in the same run', () => {
    const realtime: NormalizedMessage[] = [
      thinkingMessage('local-thinking-final', 'Inspect the flow', '2026-05-28T00:00:01.000Z', {
        isFinal: true,
        runId: 'run-1',
      }),
      thinkingMessage('__streaming_thinking_web:s_test_run-1', 'Inspect the flow', '2026-05-28T00:00:02.000Z', {
        runId: 'run-1',
      }),
    ];

    const updated = finalizeStreamingRealtimeMessages(realtime, {
      sessionId: 'web:s_test',
      runId: 'run-1',
      kind: 'thinking',
      newId: 'new-thinking-final',
    });

    expect(updated.map((message) => message.id)).toEqual(['local-thinking-final']);
  });

  it('replaces a shorter finalized thinking row with the fuller streaming block', () => {
    const realtime: NormalizedMessage[] = [
      thinkingMessage('local-thinking-final', 'Inspect the flow', '2026-05-28T00:00:01.000Z', {
        isFinal: true,
        runId: 'run-1',
      }),
      thinkingMessage(
        '__streaming_thinking_web:s_test_run-1',
        'Inspect the flow, then use the tool.',
        '2026-05-28T00:00:02.000Z',
        { runId: 'run-1' },
      ),
    ];

    const updated = finalizeStreamingRealtimeMessages(realtime, {
      sessionId: 'web:s_test',
      runId: 'run-1',
      kind: 'thinking',
      newId: 'new-thinking-final',
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe('local-thinking-final');
    expect(updated[0]?.content).toBe('Inspect the flow, then use the tool.');
  });

  it('finalizes only the matching thinking block id', () => {
    const realtime: NormalizedMessage[] = [
      thinkingMessage(
        '__streaming_thinking_web:s_test_run-1_id_block-a',
        'First block',
        '2026-05-28T00:00:01.000Z',
        { runId: 'run-1', thinkingBlockId: 'block-a', thinkingBlockSeq: 1 },
      ),
      thinkingMessage(
        '__streaming_thinking_web:s_test_run-1_id_block-b',
        'Second block',
        '2026-05-28T00:00:02.000Z',
        { runId: 'run-1', thinkingBlockId: 'block-b', thinkingBlockSeq: 2 },
      ),
    ];

    const updated = finalizeStreamingRealtimeMessages(realtime, {
      sessionId: 'web:s_test',
      runId: 'run-1',
      kind: 'thinking',
      newId: 'final-block-a',
      thinkingBlockId: 'block-a',
      thinkingBlockSeq: 1,
    });

    expect(updated.map((message) => message.id)).toEqual([
      'final-block-a',
      '__streaming_thinking_web:s_test_run-1_id_block-b',
    ]);
    expect(updated[0]?.isFinal).toBe(true);
    expect(updated[1]?.isFinal).toBeUndefined();
  });

  it('does not collapse different thinking block ids with the same text', () => {
    const realtime: NormalizedMessage[] = [
      thinkingMessage('final-block-a', 'Same text', '2026-05-28T00:00:01.000Z', {
        isFinal: true,
        runId: 'run-1',
        thinkingBlockId: 'block-a',
      }),
      thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-b', 'Same text', '2026-05-28T00:00:02.000Z', {
        runId: 'run-1',
        thinkingBlockId: 'block-b',
      }),
    ];

    const updated = finalizeStreamingRealtimeMessages(realtime, {
      sessionId: 'web:s_test',
      runId: 'run-1',
      kind: 'thinking',
      newId: 'final-block-b',
      thinkingBlockId: 'block-b',
    });

    expect(updated.map((message) => message.id)).toEqual(['final-block-a', 'final-block-b']);
  });
});

describe('pruneRealtimeMessagesAfterServerRefresh', () => {
  it('drops finalized live thinking/text once the server has the same turn content', () => {
    const server = [
      textMessage('tail-before-turn', 'Previous answer', '2026-05-28T00:00:00.000Z'),
      thinkingMessage('server-thinking', 'Inspect the flow', '2026-05-28T00:00:04.000Z'),
      textMessage('server-text', 'Final answer', '2026-05-28T00:00:05.000Z'),
    ];
    const realtime = [
      thinkingMessage('thinking-final', 'Inspect the flow', '2026-05-28T00:00:01.000Z', {
        isFinal: true,
        runId: 'run-1',
        serverTailIdAtStart: 'tail-before-turn',
        thinkingBlockId: 'block-a',
        thinkingBlockSeq: 1,
      }),
      textMessage('text-final', 'Final answer', '2026-05-28T00:00:02.000Z', {
        isFinal: true,
        runId: 'run-1',
        serverTailIdAtStart: 'tail-before-turn',
      }),
      thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-b', 'Still streaming', '2026-05-28T00:00:03.000Z', {
        runId: 'run-1',
        thinkingBlockId: 'block-b',
        thinkingBlockSeq: 2,
      }),
    ];

    const pruned = pruneRealtimeMessagesAfterServerRefresh(realtime, server);

    expect(pruned.map((message) => message.id)).toEqual([
      '__streaming_thinking_web:s_test_run-1_id_block-b',
    ]);
  });

  it('drops finalized live thinking when the server history has text without role', () => {
    const server = [
      textMessage('tail-before-turn', 'Previous answer', '2026-05-28T00:00:00.000Z'),
      {
        id: 'server-thinking',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:04.000Z',
        provider: PROVIDER,
        kind: 'thinking' as const,
        text: 'The user is just saying "hello".',
      },
      textMessage('server-text', 'Hello there', '2026-05-28T00:00:05.000Z'),
    ];
    const realtime = [
      thinkingMessage('thinking-final', 'The user is just saying "hello".', '2026-05-28T00:00:01.000Z', {
        isFinal: true,
        runId: 'run-1',
        serverTailIdAtStart: 'tail-before-turn',
      }),
    ];

    const pruned = pruneRealtimeMessagesAfterServerRefresh(realtime, server);

    expect(pruned).toEqual([]);
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
  it('uses content-stable signatures for repeated volatile snapshots with fresh ids', () => {
    const firstSnapshot = [
      {
        id: 'thinking-id-from-first-status',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:02.000Z',
        provider: PROVIDER,
        kind: 'thinking' as const,
        content: 'Checking the current flow.',
        runId: 'run-1',
      },
      {
        id: 'end-id-from-first-status',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:03.000Z',
        provider: PROVIDER,
        kind: 'stream_end' as const,
        runId: 'run-1',
      },
    ];
    const secondSnapshot = firstSnapshot.map((message) => ({
      ...message,
      id: `${message.id}-different`,
    }));

    expect(getActiveTurnReplaySignature(firstSnapshot)).toBe(
      getActiveTurnReplaySignature(secondSnapshot),
    );
  });

  it('skips stale thinking replay already covered by a longer finalized thinking block', () => {
    const activeTurnMessages = [
      {
        id: 'thinking-replay',
        sessionId: 'web:s_test',
        timestamp: '2026-05-28T00:00:02.000Z',
        provider: PROVIDER,
        kind: 'thinking' as const,
        content: 'Inspect the flow',
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
        thinkingMessage(
          'local-thinking-final',
          'Inspect the flow, then use the tool.',
          '2026-05-28T00:00:01.000Z',
          {
            isFinal: true,
            runId: 'run-1',
          },
        ),
      ],
    });

    expect(messagesToApply.map((message) => message.id)).toEqual(['tool-1']);
  });

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

describe('isThinkingReplayAlreadyRendered', () => {
  it('detects a thinking replay already covered by finalized realtime thinking', () => {
    const replay = {
      id: 'thinking-replay',
      sessionId: 'web:s_test',
      timestamp: '2026-05-28T00:00:02.000Z',
      provider: PROVIDER,
      kind: 'thinking' as const,
      text: 'The user is just saying "hello".',
      runId: 'run-1',
    };

    expect(isThinkingReplayAlreadyRendered(replay, {
      realtimeMessages: [
        thinkingMessage(
          'thinking-final',
          'The user is just saying "hello".',
          '2026-05-28T00:00:01.000Z',
          { isFinal: true, runId: 'run-1' },
        ),
      ],
    })).toBe(true);
  });

  it('does not treat a longer thinking replay as already rendered', () => {
    const replay = {
      id: 'thinking-replay',
      sessionId: 'web:s_test',
      timestamp: '2026-05-28T00:00:02.000Z',
      provider: PROVIDER,
      kind: 'thinking' as const,
      content: 'Inspect the flow, then use a tool.',
      runId: 'run-1',
    };

    expect(isThinkingReplayAlreadyRendered(replay, {
      realtimeMessages: [
        thinkingMessage('thinking-final', 'Inspect the flow', '2026-05-28T00:00:01.000Z', {
          isFinal: true,
          runId: 'run-1',
        }),
      ],
    })).toBe(false);
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

  it('replaces an active thinking stream row with a fuller duplicate thinking frame', () => {
    const existing = [
      thinkingMessage('__streaming_thinking_web:s_test_run-1', 'Inspect the flow', '2026-05-28T00:00:01.000Z', {
        runId: 'run-1',
      }),
    ];
    const incoming = thinkingMessage(
      'incoming-thinking',
      'Inspect the flow, then use the tool.',
      '2026-05-28T00:00:02.000Z',
      { runId: 'run-1' },
    );

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe('incoming-thinking');
    expect(updated[0]?.content).toBe('Inspect the flow, then use the tool.');
  });

  it('keeps an existing fuller thinking row when a stale shorter duplicate arrives', () => {
    const existing = [
      thinkingMessage(
        'existing-thinking',
        'Inspect the flow, then use the tool.',
        '2026-05-28T00:00:01.000Z',
        { runId: 'run-1' },
      ),
    ];
    const incoming = thinkingMessage('incoming-thinking', 'Inspect the flow', '2026-05-28T00:00:02.000Z', {
      runId: 'run-1',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated.map((message) => message.id)).toEqual(['existing-thinking']);
    expect(updated[0]?.content).toBe('Inspect the flow, then use the tool.');
  });

  it('does not dedupe thinking frames from different known block ids', () => {
    const existing = [
      thinkingMessage('thinking-a', 'Same text', '2026-05-28T00:00:01.000Z', {
        runId: 'run-1',
        thinkingBlockId: 'block-a',
      }),
    ];
    const incoming = thinkingMessage('thinking-b', 'Same text', '2026-05-28T00:00:02.000Z', {
      runId: 'run-1',
      thinkingBlockId: 'block-b',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated.map((message) => message.id)).toEqual(['thinking-a', 'thinking-b']);
  });

  it('dedupes thinking frames with the same block id by keeping the fuller text', () => {
    const existing = [
      thinkingMessage('thinking-a', 'Inspect', '2026-05-28T00:00:01.000Z', {
        runId: 'run-1',
        thinkingBlockId: 'block-a',
      }),
    ];
    const incoming = thinkingMessage('thinking-a-replay', 'Inspect state', '2026-05-28T00:00:02.000Z', {
      runId: 'run-1',
      thinkingBlockId: 'block-a',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe('thinking-a-replay');
    expect(updated[0]?.content).toBe('Inspect state');
  });

  it('inserts late-arriving thinking before active assistant stream content in the same run', () => {
    const existing = [
      streamingRunMessage('web:s_test', 'run-1', 'Visible answer'),
    ];
    const incoming = thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-a', 'Plan first', '2026-05-28T00:00:02.000Z', {
      runId: 'run-1',
      thinkingBlockId: 'block-a',
      thinkingBlockSeq: 1,
      serverTailIdAtStart: 'tail-before-turn',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated.map((message) => message.id)).toEqual([
      '__streaming_thinking_web:s_test_run-1_id_block-a',
      '__streaming_web:s_test_run-1',
    ]);
  });

  it('inserts late-arriving thinking before assistant text that replaced a stream row', () => {
    const existing = [
      textMessage('standalone-text', 'Visible answer', '2026-05-28T00:00:01.000Z', {
        runId: 'run-1',
        serverTailIdAtStart: 'tail-before-turn',
      }),
    ];
    const incoming = thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-a', 'Plan first', '2026-05-28T00:00:02.000Z', {
      runId: 'run-1',
      thinkingBlockId: 'block-a',
      thinkingBlockSeq: 1,
      serverTailIdAtStart: 'tail-before-turn',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated.map((message) => message.id)).toEqual([
      '__streaming_thinking_web:s_test_run-1_id_block-a',
      'standalone-text',
    ]);
  });

  it('keeps late thinking before assistant content even after the matching tool use is shown', () => {
    const existing = [
      textMessage('text-final', 'I inspected the file.', '2026-05-28T00:00:01.000Z', {
        isFinal: true,
        runId: 'run-1',
        serverTailIdAtStart: 'tail-before-turn',
      }),
      toolUseMessage('tool-read-1'),
    ];
    const incoming = thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-a', 'Decide next tool', '2026-05-28T00:00:03.000Z', {
      runId: 'run-1',
      thinkingBlockId: 'block-a',
      thinkingBlockSeq: 1,
      serverTailIdAtStart: 'tail-before-turn',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated.map((message) => message.id)).toEqual([
      '__streaming_thinking_web:s_test_run-1_id_block-a',
      'text-final',
      'tool-read-1',
    ]);
  });

  it('does not move later thinking across tool result boundaries', () => {
    const existing = [
      textMessage('text-final', 'I inspected the file.', '2026-05-28T00:00:01.000Z', {
        isFinal: true,
        runId: 'run-1',
        serverTailIdAtStart: 'tail-before-turn',
      }),
      toolUseMessage('tool-read-1'),
      toolResultMessage('tool-result-1'),
    ];
    const incoming = thinkingMessage('__streaming_thinking_web:s_test_run-1_id_block-b', 'Decide next step', '2026-05-28T00:00:05.000Z', {
      runId: 'run-1',
      thinkingBlockId: 'block-b',
      thinkingBlockSeq: 2,
      serverTailIdAtStart: 'tail-before-turn',
    });

    const updated = upsertRealtimeMessages(existing, [incoming]);

    expect(updated.map((message) => message.id)).toEqual([
      'text-final',
      'tool-read-1',
      'tool-result-1',
      '__streaming_thinking_web:s_test_run-1_id_block-b',
    ]);
  });
});

describe('useSessionStore streaming thinking blocks', () => {
  it('updates the same live row for one thinking block id and creates another row for a new block', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.updateStreamingThinking('web:s_test', 'Inspect', PROVIDER, 'run-1', 'block-a', 1);
      result.current.updateStreamingThinking('web:s_test', 'Inspect state', PROVIDER, 'run-1', 'block-a', 1);
      result.current.updateStreamingThinking('web:s_test', 'Use tool', PROVIDER, 'run-1', 'block-b', 2);
    });

    const realtime = result.current.getSessionSlot('web:s_test')?.realtimeMessages ?? [];

    expect(realtime.map((message) => message.content)).toEqual(['Inspect state', 'Use tool']);
    expect(realtime.map((message) => message.thinkingBlockId)).toEqual(['block-a', 'block-b']);
  });

  it('keeps late-arriving live thinking before active streamed assistant content', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.updateStreaming('web:s_test', 'Visible answer', PROVIDER, 'run-1');
      result.current.updateStreamingThinking('web:s_test', 'Plan first', PROVIDER, 'run-1', 'block-a', 1);
    });

    const realtime = result.current.getSessionSlot('web:s_test')?.realtimeMessages ?? [];

    expect(realtime.map((message) => message.kind)).toEqual(['thinking', 'stream_delta']);
    expect(realtime.map((message) => message.content)).toEqual(['Plan first', 'Visible answer']);
    expect(realtime[0]?.id).toBe('__streaming_thinking_web:s_test_run-1_id_block-a');
    expect(realtime[1]?.id).toBe('__streaming_web:s_test_run-1');
  });

  it('keeps late-arriving live thinking before finalized content after tool use appears', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.updateStreaming('web:s_test', 'Visible answer', PROVIDER, 'run-1');
      result.current.finalizeStreaming('web:s_test', 'run-1');
      result.current.appendRealtime('web:s_test', toolUseMessage('tool-read-1'));
      result.current.updateStreamingThinking('web:s_test', 'Plan first', PROVIDER, 'run-1', 'block-a', 1);
    });

    const realtime = result.current.getSessionSlot('web:s_test')?.realtimeMessages ?? [];

    expect(realtime.map((message) => message.kind)).toEqual(['thinking', 'text', 'tool_use']);
    expect(realtime.map((message) => message.content)).toEqual(['Plan first', 'Visible answer', undefined]);
  });

  it('finalizes only one active thinking block and leaves the next block streaming', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.updateStreamingThinking('web:s_test', 'Inspect', PROVIDER, 'run-1', 'block-a', 1);
      result.current.updateStreamingThinking('web:s_test', 'Use tool', PROVIDER, 'run-1', 'block-b', 2);
      result.current.finalizeStreamingThinking('web:s_test', 'run-1', 'block-a', 1);
      result.current.finalizeStreamingThinking('web:s_test', 'run-1', 'block-a', 1);
    });

    const realtime = result.current.getSessionSlot('web:s_test')?.realtimeMessages ?? [];

    expect(realtime).toHaveLength(2);
    expect(realtime[0]?.content).toBe('Inspect');
    expect(realtime[0]?.isFinal).toBe(true);
    expect(realtime[0]?.id.startsWith('__streaming_thinking_')).toBe(false);
    expect(realtime[1]?.content).toBe('Use tool');
    expect(realtime[1]?.isFinal).toBeUndefined();
    expect(realtime[1]?.id).toBe('__streaming_thinking_web:s_test_run-1_id_block-b');
  });

  it('preserves legacy fallback when thinking block fields are absent', () => {
    const { result } = renderHook(() => useSessionStore());

    act(() => {
      result.current.updateStreamingThinking('web:s_test', 'Legacy', PROVIDER, 'run-1');
      result.current.updateStreamingThinking('web:s_test', 'Legacy block', PROVIDER, 'run-1');
      result.current.finalizeStreamingThinking('web:s_test', 'run-1');
      result.current.finalizeStreamingThinking('web:s_test', 'run-1');
    });

    const realtime = result.current.getSessionSlot('web:s_test')?.realtimeMessages ?? [];

    expect(realtime).toHaveLength(1);
    expect(realtime[0]?.content).toBe('Legacy block');
    expect(realtime[0]?.isFinal).toBe(true);
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
