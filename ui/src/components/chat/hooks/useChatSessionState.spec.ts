import { describe, expect, it } from 'vitest';
import type { SessionProvider } from '../../../types/app';
import type { ChatMessage } from '../types/types';
import { chatMessageToNormalized, resolveConversationScrollTop } from './useChatSessionState';

describe('chatMessageToNormalized', () => {
  it('preserves user turn identity on optimistic rows', () => {
    const message: ChatMessage = {
      type: 'user',
      content: 'Continue.',
      runId: 'run-user-1',
      turnId: 'turn-user-1',
      timestamp: new Date('2026-08-18T00:00:00.000Z'),
    };

    expect(chatMessageToNormalized(
      message,
      'web:session-1',
      'pilotdeck' as SessionProvider,
    )).toMatchObject({
      kind: 'text',
      role: 'user',
      runId: 'run-user-1',
      turnId: 'turn-user-1',
    });
  });
});

describe('resolveConversationScrollTop', () => {
  it('preserves an explicitly paused position even a few pixels from the bottom', () => {
    expect(resolveConversationScrollTop(
      { top: 795, distanceFromBottom: 5, following: false },
      1600,
      400,
    )).toBe(795);
  });
  it('keeps a conversation pinned to the bottom when it was near the bottom', () => {
    expect(resolveConversationScrollTop(
      { top: 720, distanceFromBottom: 20 },
      1200,
      400,
    )).toBe(800);
  });

  it('restores an earlier reading position away from the bottom', () => {
    expect(resolveConversationScrollTop(
      { top: 320, distanceFromBottom: 480 },
      1200,
      400,
    )).toBe(320);
  });

  it('clamps a stored position when the transcript becomes shorter', () => {
    expect(resolveConversationScrollTop(
      { top: 900, distanceFromBottom: 200 },
      700,
      400,
    )).toBe(300);
  });
});
