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
      compactTrigger: 'auto',
      preTokens: 120,
      postTokens: 40,
      messagesSummarized: 2,
    });
  });
});
