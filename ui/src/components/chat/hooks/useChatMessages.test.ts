import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';

const complete: NormalizedMessage = {
  id: 'stop', sessionId: 'session', runId: 'run', provider: 'pilotdeck', kind: 'complete',
  timestamp: '2026-11-10T00:00:02Z', finishReason: 'aborted',
};

describe('completion presentation', () => {
  it('retains a user stop without timing instead of discarding the completion frame', () => {
    expect(normalizedToChatMessages([complete])).toMatchObject([
      { id: 'stop', runId: 'run', type: 'system', isInterruptedNotice: true },
    ]);
  });
  it('retains cancellation timing so the process can show a duration and stop notice', () => {
    const messages = normalizedToChatMessages([{ ...complete, turnTiming: {
      startedAt: '2026-11-10T00:00:00Z', completedAt: complete.timestamp,
    } }]);
    expect(messages).toMatchObject([{ isAgentActivitySummary: true, state: 'cancelled', durationMs: 2000 }]);
  });
  it('does not introduce a user stop for ordinary untimed completion', () => {
    expect(normalizedToChatMessages([{ ...complete, finishReason: 'completed' }])).toEqual([]);
  });
  it('preserves execution bounds carried by an invisible historical status', () => {
    const messages = normalizedToChatMessages([{ ...complete, kind: 'status', finishReason: undefined, turnTiming: {
      startedAt: '2026-11-10T00:00:00Z', completedAt: complete.timestamp, finishReason: 'aborted_streaming',
    } }]);
    expect(messages).toMatchObject([{ runId: 'run', isAgentActivitySummary: true, state: 'cancelled', durationMs: 2000 }]);
    expect(messages[0].turnTiming).toBeUndefined();
    expect(normalizedToChatMessages([{ ...complete, kind: 'status', finishReason: undefined }])).toEqual([]);
  });
});
