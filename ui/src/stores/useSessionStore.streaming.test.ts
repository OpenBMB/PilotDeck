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
  getRealtimeMessagesToKeepAfterServerRefresh,
  getUnpersistedRealtimeTurnMessages,
  isRealtimeMessageRepresentedOnServer,
  patchMergedStreamingMessage,
  preserveTerminalAgentActivity,
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

describe('assistant attachment history reconciliation', () => {
  it('deduplicates empty assistant attachment messages by attachment identity', () => {
    const live = textMessage('live-attachment', '', '2026-05-28T00:00:00.000Z', {
      runId: 'run-attachment',
      turnId: 'run-attachment',
      attachments: [{ name: 'report.txt', path: '/workspace/report.txt', mimeType: 'text/plain' }],
    });
    const persisted = textMessage('persisted-attachment', '', '2026-05-28T00:00:01.000Z', {
      runId: 'run-attachment',
      turnId: 'run-attachment',
      attachments: [{ name: 'report.txt', path: '/workspace/report.txt', mimeType: 'text/plain' }],
    });

    expect(isRealtimeMessageRepresentedOnServer(live, [persisted])).toBe(true);
    expect(computeMerged([persisted], [live]).map((message) => message.id)).toEqual([
      'persisted-attachment',
    ]);
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

describe('preserveTerminalAgentActivity', () => {
  it('does not reopen a cancelled activity when an older running update is replayed', () => {
    const cancelled: NormalizedMessage = {
      id: 'subagent-activity',
      sessionId: 'cron:task-1',
      timestamp: '2026-08-05T00:02:00.000Z',
      provider: PROVIDER,
      kind: 'agent_activity',
      activityId: 'subagent:one',
      state: 'cancelled',
      endedAt: '2026-08-05T00:02:00.000Z',
    };
    const replayedRunning: NormalizedMessage = {
      ...cancelled,
      timestamp: '2026-08-05T00:00:00.000Z',
      state: 'running',
      endedAt: undefined,
    };

    expect(preserveTerminalAgentActivity(cancelled, replayedRunning)).toBe(cancelled);
  });

  it('accepts a newer explicit terminal result', () => {
    const cancelled: NormalizedMessage = {
      id: 'subagent-activity',
      sessionId: 'cron:task-1',
      timestamp: '2026-08-05T00:02:00.000Z',
      provider: PROVIDER,
      kind: 'agent_activity',
      activityId: 'subagent:one',
      state: 'cancelled',
    };
    const completed: NormalizedMessage = {
      ...cancelled,
      timestamp: '2026-08-05T00:03:00.000Z',
      state: 'completed',
    };

    expect(preserveTerminalAgentActivity(cancelled, completed)).toBe(completed);
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
  it('deduplicates an optimistic user message from its persisted attachment prompt', () => {
    const server = [
      textMessage(
        'persisted-user',
        [
          'Transcribe this audio.',
          '',
          '[Files attached by user and available for reading in the project:]',
          '- meeting.wav: .tmp/meeting.wav',
          '[End files attached by user]',
          '',
          '[Registered attachment files in this session:]',
          '- meeting.wav: .tmp/meeting.wav',
          'Use the audio transcription tool for this attachment.',
        ].join('\n'),
        '2026-08-16T09:00:00.050Z',
        { role: 'user' },
      ),
    ];
    const realtime = [
      textMessage('local_user', 'Transcribe this audio.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        attachments: [{
          name: 'meeting.wav',
          path: '.tmp/meeting.wav',
        }],
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'persisted-user',
    ]);
  });

  it('deduplicates an optimistic user message from its persisted content reference prompt', () => {
    const server = [
      textMessage(
        'persisted-user',
        [
          'Summarize this selection.',
          '',
          '[Content references selected by user:]',
          '1. TEXT reference',
          '   Source: notes.md',
          '   Reference JSON: {"schemaVersion":1,"kind":"content-reference","id":"content-reference-1","selectionMode":"text","source":{"relativePath":"notes.md","fileName":"notes.md"},"renderer":{"id":"text","backend":"builtin","locatorQuality":"semantic"},"createdAt":"2026-08-16T09:00:00.000Z","locator":{"surface":"document","quote":{"exact":"selection"}},"selectedText":"selection"}',
        ].join('\n'),
        '2026-08-16T09:00:00.050Z',
        { role: 'user' },
      ),
    ];
    const realtime = [
      textMessage('local_user', 'Summarize this selection.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        attachments: [{
          kind: 'content-reference',
          name: 'notes.md',
          path: 'notes.md',
          contentReference: {
            schemaVersion: 1,
            kind: 'content-reference',
            id: 'content-reference-1',
            selectionMode: 'text',
            source: { relativePath: 'notes.md', fileName: 'notes.md' },
            renderer: { id: 'text', backend: 'builtin', locatorQuality: 'semantic' },
            createdAt: '2026-08-16T09:00:00.000Z',
            locator: { surface: 'document', quote: { exact: 'selection' } },
            selectedText: 'selection',
          },
        }],
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'persisted-user',
    ]);
  });

  it('keeps a second same-text optimistic message with different attachments', () => {
    const server = [
      textMessage(
        'persisted-first-user',
        [
          'Please review the attached file(s).',
          '',
          '[Files attached by user and available for reading in the project:]',
          '- first.pdf: .tmp/first.pdf',
          '[End files attached by user]',
        ].join('\n'),
        '2026-08-16T09:00:00.050Z',
        { role: 'user' },
      ),
    ];
    const realtime = [
      textMessage('local_first', 'Please review the attached file(s).', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        attachments: [{ name: 'first.pdf', path: '.tmp/first.pdf' }],
      }),
      textMessage('local_second', 'Please review the attached file(s).', '2026-08-16T09:00:00.100Z', {
        role: 'user',
        attachments: [{ name: 'second.pdf', path: '.tmp/second.pdf' }],
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'persisted-first-user',
      'local_second',
    ]);
  });

  it('keeps a second same-text optimistic message with different image inputs', () => {
    const server = [
      textMessage('persisted-first-user', 'Describe this image.', '2026-08-16T09:00:00.050Z', {
        role: 'user',
        images: ['data:image/png;base64,first'],
      }),
    ];
    const realtime = [
      textMessage('local_first', 'Describe this image.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        images: ['data:image/png;base64,first'],
      }),
      textMessage('local_second', 'Describe this image.', '2026-08-16T09:00:00.100Z', {
        role: 'user',
        images: ['data:image/png;base64,second'],
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'persisted-first-user',
      'local_second',
    ]);
  });

  it('matches persisted user messages to identical optimistic sends one-to-one', () => {
    const server = [
      textMessage('persisted-first-user', 'Continue.', '2026-08-16T09:00:00.050Z', {
        role: 'user',
      }),
    ];
    const realtime = [
      textMessage('local_first', 'Continue.', '2026-08-16T09:00:00.000Z', { role: 'user' }),
      textMessage('local_second', 'Continue.', '2026-08-16T09:00:00.100Z', { role: 'user' }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'persisted-first-user',
      'local_second',
    ]);
  });

  it('confirms an optimistic user row only from the same persisted turn identity', () => {
    const server = [
      textMessage('persisted-user', 'Continue.\n\n[Files attached by user]', '2026-08-16T09:00:30.000Z', {
        role: 'user',
        turnId: 'run-user-1',
        runId: 'run-user-1',
      }),
    ];
    const realtime = [
      textMessage('local_user', 'Continue.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        runId: 'run-user-1',
      }),
    ];

    expect(computeMerged(server, realtime)).toEqual(server);
    expect(getRealtimeMessagesToKeepAfterServerRefresh(realtime, server)).toEqual([]);
  });

  it('does not let an older same-text turn confirm a new optimistic send', () => {
    const server = [
      textMessage('persisted-old-user', 'Continue.', '2026-08-16T09:00:05.000Z', {
        role: 'user',
        turnId: 'run-old',
        runId: 'run-old',
      }),
    ];
    const realtime = [
      textMessage('local_new_user', 'Continue.', '2026-08-16T09:00:05.100Z', {
        role: 'user',
        runId: 'run-new',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'persisted-old-user',
      'local_new_user',
    ]);
    expect(getRealtimeMessagesToKeepAfterServerRefresh(realtime, server)).toEqual(realtime);
  });

  it('keeps an id-bearing optimistic send after its captured history tail despite clock skew', () => {
    const server = [
      textMessage('persisted-old-user', 'Old prompt', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        turnId: 'run-old',
        runId: 'run-old',
      }),
      textMessage('persisted-old-answer', 'Old answer', '2026-08-16T09:00:01.000Z', {
        role: 'assistant',
        turnId: 'run-old',
        runId: 'run-old',
      }),
    ];
    const realtime = [
      textMessage('local_new_user', 'New prompt', '2026-08-16T08:00:00.000Z', {
        role: 'user',
        runId: 'run-new',
        serverTailIdAtStart: 'persisted-old-answer',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'persisted-old-user',
      'persisted-old-answer',
      'local_new_user',
    ]);
  });

  it('preserves realtime turn order while anchoring optimistic users after the server tail', () => {
    const server = [
      textMessage('persisted-old-answer', 'Old answer', '2026-08-16T09:00:01.000Z'),
    ];
    const realtime = [
      textMessage('local_first_user', 'First prompt', '2026-08-16T08:00:00.000Z', {
        role: 'user',
        runId: 'run-first',
        serverTailIdAtStart: 'persisted-old-answer',
      }),
      streamingMessage('web:s_test', 'First answer'),
      textMessage('local_second_user', 'Second prompt', '2026-08-16T08:00:01.000Z', {
        role: 'user',
        runId: 'run-second',
        serverTailIdAtStart: 'persisted-old-answer',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'persisted-old-answer',
      'local_first_user',
      '__streaming_web:s_test',
      'local_second_user',
    ]);
  });

  it('keeps an unpersisted retry while confirming a same-text send by run id', () => {
    const server = [
      textMessage('persisted-second-user', 'Continue.', '2026-08-16T09:00:00.100Z', {
        role: 'user',
        turnId: 'run-second',
        runId: 'run-second',
      }),
    ];
    const realtime = [
      textMessage('local_failed_first', 'Continue.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        runId: 'run-first',
      }),
      textMessage('local_confirmed_second', 'Continue.', '2026-08-16T09:00:00.100Z', {
        role: 'user',
        runId: 'run-second',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'local_failed_first',
      'persisted-second-user',
    ]);
  });

  it('confirms same-text queued sends by run id regardless of message order', () => {
    const server = [
      textMessage('persisted-second-user', 'Continue.', '2026-08-16T09:00:09.000Z', {
        role: 'user',
        turnId: 'run-second',
        runId: 'run-second',
      }),
      textMessage('persisted-first-user', 'Continue.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        turnId: 'run-first',
        runId: 'run-first',
      }),
    ];
    const realtime = [
      textMessage('local_first', 'Continue.', '2026-08-16T08:59:51.000Z', {
        role: 'user',
        runId: 'run-first',
      }),
      textMessage('local_second', 'Continue.', '2026-08-16T09:00:05.000Z', {
        role: 'user',
        runId: 'run-second',
      }),
    ];

    expect(computeMerged(server, realtime)).toEqual(server);
    expect(getRealtimeMessagesToKeepAfterServerRefresh(realtime, server)).toEqual([]);
  });

  it('does not mix exact-id and legacy user confirmation', () => {
    const identitylessServer = [
      textMessage('persisted-legacy-user', 'Continue.', '2026-08-16T09:00:00.050Z', {
        role: 'user',
      }),
    ];
    const identifiedRealtime = [
      textMessage('local_identified', 'Continue.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        runId: 'run-new',
      }),
    ];

    expect(computeMerged(identitylessServer, identifiedRealtime).map((message) => message.id)).toEqual([
      'local_identified',
      'persisted-legacy-user',
    ]);
  });

  it('matches a persisted send to the closest optimistic timestamp', () => {
    const server = [
      textMessage('persisted-second-user', 'Continue.', '2026-08-16T09:00:00.100Z', {
        role: 'user',
      }),
    ];
    const realtime = [
      textMessage('local_failed_first', 'Continue.', '2026-08-16T09:00:00.000Z', { role: 'user' }),
      textMessage('local_confirmed_second', 'Continue.', '2026-08-16T09:00:00.100Z', { role: 'user' }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'local_failed_first',
      'persisted-second-user',
    ]);
  });

  it('maximizes confirmed sends before minimizing timestamp distance', () => {
    const server = [
      textMessage('tail-before-sends', 'Previous answer', '2026-08-16T08:59:49.000Z'),
      textMessage('persisted-first-user', 'Continue.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
      }),
      textMessage('persisted-second-user', 'Continue.', '2026-08-16T09:00:09.000Z', {
        role: 'user',
      }),
    ];
    const realtime = [
      textMessage('local_first', 'Continue.', '2026-08-16T08:59:51.000Z', {
        role: 'user',
        serverTailIdAtStart: 'tail-before-sends',
      }),
      textMessage('local_second', 'Continue.', '2026-08-16T09:00:05.000Z', {
        role: 'user',
        serverTailIdAtStart: 'tail-before-sends',
      }),
    ];

    expect(computeMerged(server, realtime)).toEqual(server);
    expect(getRealtimeMessagesToKeepAfterServerRefresh(realtime, server)).toEqual([]);
  });

  it('does not confirm a new identical send from the captured server tail', () => {
    const server = [
      textMessage('persisted-previous-user', 'Continue.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
      }),
    ];
    const realtime = [
      textMessage('local_new_send', 'Continue.', '2026-08-16T09:00:05.000Z', {
        role: 'user',
        serverTailIdAtStart: 'persisted-previous-user',
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'persisted-previous-user',
      'local_new_send',
    ]);
    expect(getRealtimeMessagesToKeepAfterServerRefresh(realtime, server)).toEqual(realtime);
  });

  it('confirms an identical send persisted after the captured server tail', () => {
    const server = [
      textMessage('persisted-previous-user', 'Continue.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
      }),
      textMessage('persisted-new-user', 'Continue.', '2026-08-16T09:00:05.050Z', {
        role: 'user',
      }),
    ];
    const realtime = [
      textMessage('local_new_send', 'Continue.', '2026-08-16T09:00:05.000Z', {
        role: 'user',
        serverTailIdAtStart: 'persisted-previous-user',
      }),
    ];

    expect(computeMerged(server, realtime)).toEqual(server);
    expect(getRealtimeMessagesToKeepAfterServerRefresh(realtime, server)).toEqual([]);
  });

  it('keeps the second identical optimistic send during server-refresh cleanup', () => {
    const server = [
      textMessage('persisted-first-user', 'Continue.', '2026-08-16T09:00:00.050Z', {
        role: 'user',
      }),
    ];
    const realtime = [
      textMessage('local_first', 'Continue.', '2026-08-16T09:00:00.000Z', { role: 'user' }),
      textMessage('local_second', 'Continue.', '2026-08-16T09:00:00.100Z', { role: 'user' }),
    ];
    const retained = getRealtimeMessagesToKeepAfterServerRefresh(realtime, server);

    expect(retained.map((message) => message.id)).toEqual(['local_second']);
  });

  it('uses the closest optimistic timestamp during refresh cleanup', () => {
    const server = [
      textMessage('persisted-second-user', 'Continue.', '2026-08-16T09:00:00.100Z', {
        role: 'user',
      }),
    ];
    const realtime = [
      textMessage('local_failed_first', 'Continue.', '2026-08-16T09:00:00.000Z', { role: 'user' }),
      textMessage('local_confirmed_second', 'Continue.', '2026-08-16T09:00:00.100Z', { role: 'user' }),
    ];

    expect(getRealtimeMessagesToKeepAfterServerRefresh(realtime, server).map((message) => message.id)).toEqual([
      'local_failed_first',
    ]);
  });

  it('keeps optimistic messages whose image input order differs from the persisted message', () => {
    const server = [
      textMessage('persisted-user', 'Compare these images.', '2026-08-16T09:00:00.050Z', {
        role: 'user',
        images: ['data:image/png;base64,first', 'data:image/png;base64,second'],
      }),
    ];
    const realtime = [
      textMessage('local_ws_user', 'Compare these images.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        images: ['data:image/png;base64,second', 'data:image/png;base64,first'],
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'local_ws_user',
      'persisted-user',
    ]);
  });

  it('keeps optimistic messages whose attachment input order differs from the persisted message', () => {
    const server = [
      textMessage('persisted-user', 'Compare these files.', '2026-08-16T09:00:00.050Z', {
        role: 'user',
        attachments: [
          { name: 'first.pdf', path: '.tmp/first.pdf' },
          { name: 'second.pdf', path: '.tmp/second.pdf' },
        ],
      }),
    ];
    const realtime = [
      textMessage('local_user', 'Compare these files.', '2026-08-16T09:00:00.000Z', {
        role: 'user',
        attachments: [
          { name: 'second.pdf', path: '.tmp/second.pdf' },
          { name: 'first.pdf', path: '.tmp/first.pdf' },
        ],
      }),
    ];

    expect(computeMerged(server, realtime).map((message) => message.id)).toEqual([
      'local_user',
      'persisted-user',
    ]);
  });

  it('deduplicates a persisted gateway failure from its same-turn realtime status', () => {
    const persisted: NormalizedMessage = {
      id: 'persisted-gateway-failure',
      sessionId: 'web:s_test',
      timestamp: '2026-08-13T00:00:01.000Z',
      provider: PROVIDER,
      kind: 'error',
      content: 'Unknown projectKey: /Users/example/.pilotdeck',
      turnId: 'run-failure',
      runId: 'run-failure',
    };
    const realtime: NormalizedMessage = {
      ...persisted,
      id: 'realtime-gateway-failure',
      timestamp: '2026-08-13T00:00:00.000Z',
    };

    expect(computeMerged([persisted], [realtime])).toEqual([persisted]);
  });

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
      compactionId: 'compact-current',
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
      trigger: 'reactive',
      messagesSummarized: 3,
    };

    expect(shouldKeepRealtimeAfterServerRefresh(liveBoundary, staleServer)).toBe(true);
    expect(computeMerged(staleServer, [liveBoundary]).map((message) => message.id)).toEqual([
      'previous-answer',
      'live-compact',
    ]);

    expect(isRealtimeMessageRepresentedOnServer(liveBoundary, [persistedBoundary])).toBe(true);
    expect(shouldKeepRealtimeAfterServerRefresh(liveBoundary, [persistedBoundary])).toBe(false);
    expect(getUnpersistedRealtimeTurnMessages(
      [liveBoundary],
      [persistedBoundary],
      'run-current',
    )).toEqual([]);
    expect(computeMerged([persistedBoundary], [liveBoundary]).map((message) => message.id)).toEqual([
      'persisted-compact',
    ]);
  });

  it('dedupes legacy compact boundaries despite historical metadata drift', () => {
    const liveBoundary: NormalizedMessage = {
      id: 'live-compact',
      sessionId: 'web:s_test',
      timestamp: '2026-05-28T00:00:02.000Z',
      provider: PROVIDER,
      kind: 'compact_boundary',
      runId: 'run-current',
      trigger: 'auto',
      preTokens: 22994,
      postTokens: 7290,
      messagesSummarized: 28,
    };
    const persistedBoundary: NormalizedMessage = {
      ...liveBoundary,
      id: 'persisted-compact',
      turnId: 'run-current',
      runId: undefined,
      trigger: 'reactive',
      messagesSummarized: 27,
    };
    const finalAnswer = textMessage(
      'final-answer',
      'Workbook delivered.',
      '2026-05-28T00:00:05.000Z',
      { turnId: 'run-current', runId: 'run-current' },
    );

    expect(computeMerged(
      [persistedBoundary, finalAnswer],
      [liveBoundary],
    ).map((message) => message.id)).toEqual([
      'persisted-compact',
      'final-answer',
    ]);
    expect(getUnpersistedRealtimeTurnMessages(
      [liveBoundary],
      [persistedBoundary, finalAnswer],
      'run-current',
    )).toEqual([]);
  });

  it('does not merge distinct compactions in the same turn', () => {
    const firstBoundary: NormalizedMessage = {
      id: 'compact-1-live',
      sessionId: 'web:s_test',
      timestamp: '2026-05-28T00:00:02.000Z',
      provider: PROVIDER,
      kind: 'compact_boundary',
      runId: 'run-current',
      compactionId: 'compact-1',
      preTokens: 120,
      postTokens: 40,
    };
    const secondBoundary: NormalizedMessage = {
      ...firstBoundary,
      id: 'compact-2-history',
      turnId: 'run-current',
      compactionId: 'compact-2',
    };

    expect(isRealtimeMessageRepresentedOnServer(firstBoundary, [secondBoundary])).toBe(false);
    expect(computeMerged([secondBoundary], [firstBoundary]).map((message) => message.id)).toEqual([
      'compact-2-history',
      'compact-1-live',
    ]);
  });

  it('upserts replayed compact boundaries by turn and compaction id', () => {
    const firstBoundary: NormalizedMessage = {
      id: 'compact-live-random-id',
      sessionId: 'web:s_test',
      timestamp: '2026-05-28T00:00:02.000Z',
      provider: PROVIDER,
      kind: 'compact_boundary',
      runId: 'run-current',
      compactionId: 'compact-1',
      preTokens: 120,
      postTokens: 40,
    };
    const replayedBoundary: NormalizedMessage = {
      ...firstBoundary,
      id: 'compact-replay-new-random-id',
      timestamp: '2026-05-28T00:01:00.000Z',
    };

    const upserted = upsertRealtimeMessages([firstBoundary], [replayedBoundary]);

    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toBe(replayedBoundary);
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
  it('drops a replayed compact boundary already represented in realtime state', () => {
    const renderedBoundary: NormalizedMessage = {
      id: 'compact-live',
      sessionId: 'web:s_test',
      timestamp: '2026-05-28T00:00:02.000Z',
      provider: PROVIDER,
      kind: 'compact_boundary',
      runId: 'run-1',
      compactionId: 'compact-1',
      preTokens: 120,
      postTokens: 40,
    };
    const replayedBoundary = {
      ...renderedBoundary,
      id: 'compact-replayed-with-new-id',
      timestamp: '2026-05-28T00:01:00.000Z',
    };

    expect(getActiveTurnReplayMessagesToApply(
      [replayedBoundary],
      { realtimeMessages: [renderedBoundary] },
    )).toEqual([]);
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
