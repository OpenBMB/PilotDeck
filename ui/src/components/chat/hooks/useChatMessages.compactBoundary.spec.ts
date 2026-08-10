import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';

describe('compact boundary message conversion', () => {
  it('keeps one visible boundary between pre-compact and post-compact messages', () => {
    const messages: NormalizedMessage[] = [
      {
        id: 'before',
        sessionId: 'web:s_compact',
        timestamp: '2026-08-02T00:00:00.000Z',
        provider: 'pilotdeck',
        kind: 'text',
        role: 'assistant',
        content: 'Before compact',
        turnId: 'turn-old',
      },
      {
        id: 'compact',
        sessionId: 'web:s_compact',
        timestamp: '2026-08-02T00:00:01.000Z',
        provider: 'pilotdeck',
        kind: 'compact_boundary',
        turnId: 'turn-compact',
        compactionId: 'compact-1',
        trigger: 'auto',
        preTokens: 120,
        postTokens: 40,
        messagesSummarized: 2,
      },
      {
        id: 'after',
        sessionId: 'web:s_compact',
        timestamp: '2026-08-02T00:00:02.000Z',
        provider: 'pilotdeck',
        kind: 'text',
        role: 'assistant',
        content: 'After compact',
        turnId: 'turn-new',
      },
    ];

    const converted = normalizedToChatMessages(messages);

    expect(converted.map((message) => message.id)).toEqual(['before', 'compact', 'after']);
    expect(converted[1]).toMatchObject({
      type: 'system',
      isCompactBoundary: true,
      turnId: 'turn-compact',
      compactionId: 'compact-1',
      compactTrigger: 'auto',
      preTokens: 120,
      postTokens: 40,
      messagesSummarized: 2,
    });
  });
});

describe('tool message conversion', () => {
  it('keeps turn identity for stable expansion state across realtime reconciliation', () => {
    const messages: NormalizedMessage[] = [{
      id: 'live-tool-frame',
      sessionId: 'web:s_tool',
      timestamp: '2026-08-07T00:00:00.000Z',
      provider: 'pilotdeck',
      kind: 'tool_use',
      runId: 'turn-1',
      toolId: 'call-stable-1',
      toolName: 'execute_code',
      toolInput: { code: 'print(1)' },
    }];

    const [converted] = normalizedToChatMessages(messages);

    expect(converted).toMatchObject({
      id: 'live-tool-frame',
      turnId: 'turn-1',
      runId: 'turn-1',
      toolId: 'call-stable-1',
      isToolUse: true,
    });
  });
});
