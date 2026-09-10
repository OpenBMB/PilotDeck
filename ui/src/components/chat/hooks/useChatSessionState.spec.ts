import { describe, expect, it } from 'vitest';
import type { SessionProvider } from '../../../types/app';
import type { ChatMessage } from '../types/types';
import {
  chatMessageToNormalized,
  hasEquivalentUserMessage,
  resolveConversationScrollTop,
} from './useChatSessionState';

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

describe('hasEquivalentUserMessage', () => {
  it('matches a pending image query to its same-turn persisted text projection', () => {
    const pending: ChatMessage = {
      type: 'user',
      content: '这个是不是设置的太高了 或者跳跃太矮了',
      images: [{ data: 'data:image/png;base64,realtime-preview', name: 'game.png' }],
      runId: 'run-image-1',
      timestamp: new Date('2026-09-10T09:00:00.000Z'),
    };
    const persisted: ChatMessage = {
      id: 'persisted-user',
      type: 'user',
      content: '这个是不是设置的太高了 或者跳跃太矮了',
      turnId: 'run-image-1',
      timestamp: '2026-09-10T09:00:00.100Z',
    };

    expect(hasEquivalentUserMessage([persisted], pending)).toBe(true);
  });

  it('does not match the same image query from a different turn', () => {
    const pending: ChatMessage = {
      type: 'user',
      content: 'Describe this image.',
      images: [{ data: 'data:image/png;base64,new', name: 'new.png' }],
      runId: 'run-new',
      timestamp: new Date('2026-09-10T09:00:01.000Z'),
    };
    const previous: ChatMessage = {
      id: 'previous-user',
      type: 'user',
      content: 'Describe this image.',
      images: [{ data: 'data:image/png;base64,new', name: 'new.png' }],
      turnId: 'run-old',
      timestamp: '2026-09-10T09:00:00.000Z',
    };

    expect(hasEquivalentUserMessage([previous], pending)).toBe(false);
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
