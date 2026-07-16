import { describe, expect, it } from 'vitest';
import { resolveConversationScrollTop } from './useChatSessionState';

describe('resolveConversationScrollTop', () => {
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
