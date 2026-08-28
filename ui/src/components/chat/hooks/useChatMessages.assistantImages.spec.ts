import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';

describe('normalizedToChatMessages assistant images', () => {
  it('preserves metadata-rich assistant images for the web renderer', () => {
    const messages: NormalizedMessage[] = [{
      id: 'assistant-image-1',
      sessionId: 'session-1',
      provider: 'pilotdeck',
      timestamp: '2026-08-28T00:00:00.000Z',
      kind: 'text',
      role: 'assistant',
      content: '',
      images: [{
        data: 'data:image/png;base64,aGVsbG8=',
        name: 'chart.png',
        mimeType: 'image/png',
        size: 5,
      }],
    }];

    expect(normalizedToChatMessages(messages)).toMatchObject([{
      type: 'assistant',
      content: '',
      images: [{
        data: 'data:image/png;base64,aGVsbG8=',
        name: 'chart.png',
        mimeType: 'image/png',
        size: 5,
      }],
    }]);
  });
});
