import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../stores/useSessionStore';
import type { SessionProvider } from '../../types/app';
import { inheritSubagentRenderKeys, mergeSubagentDetailMessages } from './useSubagentMessages';

const PROVIDER = 'pilotdeck' as SessionProvider;

function textMessage(
  id: string,
  content: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1::sub::subagent-1',
    timestamp,
    provider: PROVIDER,
    kind: 'text',
    role: 'assistant',
    content,
    ...overrides,
  };
}

function streamMessage(id: string, content: string, timestamp: string): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1::sub::subagent-1',
    timestamp,
    provider: PROVIDER,
    kind: 'stream_delta',
    role: 'assistant',
    content,
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
    sessionId: 'session-1::sub::subagent-1',
    timestamp,
    provider: PROVIDER,
    kind: 'thinking',
    role: 'assistant',
    content,
    ...overrides,
  };
}

describe('mergeSubagentDetailMessages', () => {
  it('drops finalized realtime assistant text already covered by snapshot text', () => {
    const snapshot = [
      textMessage('snapshot-text', 'Persisted answer', '2026-05-28T00:00:02.000Z'),
    ];
    const realtime = [
      textMessage('subagent_text_local_final', 'Realtime answer', '2026-05-28T00:00:01.000Z'),
    ];

    expect(mergeSubagentDetailMessages(snapshot, realtime, false).map((message) => message.id)).toEqual([
      'snapshot-text',
    ]);
  });

  it('keeps active subagent stream deltas after snapshot text', () => {
    const snapshot = [
      textMessage('snapshot-text', 'Persisted answer', '2026-05-28T00:00:02.000Z'),
    ];
    const realtime = [
      streamMessage('__subagent_streaming_session-1_subagent-1', 'Still streaming', '2026-05-28T00:00:03.000Z'),
    ];

    expect(mergeSubagentDetailMessages(snapshot, realtime, false).map((message) => message.id)).toEqual([
      'snapshot-text',
      '__subagent_streaming_session-1_subagent-1',
    ]);
  });

  it('keeps newer finalized realtime thinking when snapshot only has older thinking', () => {
    const snapshot = [
      thinkingMessage('snapshot-thinking-old', 'Older persisted thought', '2026-05-28T00:00:01.000Z'),
    ];
    const realtime = [
      thinkingMessage('subagent_thinking_session-1_subagent-1_2', 'New local thought', '2026-05-28T00:00:03.000Z'),
    ];

    expect(mergeSubagentDetailMessages(snapshot, realtime, false).map((message) => message.id)).toEqual([
      'snapshot-thinking-old',
      'subagent_thinking_session-1_subagent-1_2',
    ]);
  });

  it('drops finalized realtime thinking already covered by newer snapshot thinking', () => {
    const snapshot = [
      thinkingMessage('snapshot-thinking-new', 'Persisted thought', '2026-05-28T00:00:03.000Z'),
    ];
    const realtime = [
      thinkingMessage('subagent_thinking_session-1_subagent-1_1', 'Local thought', '2026-05-28T00:00:02.000Z'),
    ];

    expect(mergeSubagentDetailMessages(snapshot, realtime, false).map((message) => message.id)).toEqual([
      'snapshot-thinking-new',
    ]);
  });
});


describe('subagent snapshot rendering identity', () => {
  it('preserves stream identity when snapshots omit the thinking role and change message IDs', () => {
    const previous = [thinkingMessage('live', 'A thought', '2026-05-28T00:00:01Z', { renderKey: 'reading' })];
    const snapshot = [thinkingMessage('persisted', 'A thought', '2026-05-28T00:00:02Z', { role: undefined })];
    expect(inheritSubagentRenderKeys(previous, snapshot)[0].renderKey).toBe('reading');
  });

  it('assigns repeated identical thoughts one to one in transcript order', () => {
    const previous = ['first', 'second'].map((id) => thinkingMessage(id, 'Again', '2026-05-28T00:00:01Z', { renderKey: id }));
    const snapshot = ['persisted-a', 'persisted-b'].map((id) => thinkingMessage(id, 'Again', '2026-05-28T00:00:02Z'));
    expect(inheritSubagentRenderKeys(previous, snapshot).map((message) => message.renderKey)).toEqual(['first', 'second']);
    expect(inheritSubagentRenderKeys(previous, snapshot.slice(0, 1))[0].renderKey).toBe('persisted-a');
  });

  it('keeps tool invocation identity when its result/content changes', () => {
    const previous = [textMessage('live-tool', '', '2026-05-28T00:00:01Z', { kind: 'tool_use', toolId: 'call', renderKey: 'tool-row' })];
    const snapshot = [textMessage('persisted-tool', 'Completed', '2026-05-28T00:00:02Z', { kind: 'tool_use', toolId: 'call' })];
    expect(inheritSubagentRenderKeys(previous, snapshot)[0].renderKey).toBe('tool-row');
  });
});
