import { describe, expect, it } from 'vitest';
import type { SessionProvider } from '../../../types/app';
import type { ChatMessage } from '../types/types';
import {
  chatMessageToNormalized,
  hasEquivalentUserMessage,
  resolveConversationScrollTop,
  didLoadedSessionChange,
  getStreamContentKey,
  isScrollNearBottom,
  selectVisibleMessages,
  shouldFollowConversationScroll,
  shouldRenderPendingBubble,
} from './useChatSessionState';

describe('useChatSessionState scroll helpers', () => {
  it('uses a wider bottom threshold for streaming follow mode', () => {
    expect(isScrollNearBottom(805, 1000, 100)).toBe(true);
    expect(isScrollNearBottom(803, 1000, 100)).toBe(false);
  });

  it('stops following content growth after the user scrolls up', () => {
    expect(shouldFollowConversationScroll(true, false)).toBe(true);
    expect(shouldFollowConversationScroll(true, true)).toBe(false);
    expect(shouldFollowConversationScroll(false, false)).toBe(false);
  });

  it('changes the stream content key when the last visible message grows', () => {
    const baseMessages: ChatMessage[] = [
      {
        id: 'user-1',
        type: 'user',
        content: 'hello',
        timestamp: '2026-05-18T00:00:00.000Z',
      },
      {
        id: 'assistant-1',
        type: 'assistant',
        content: 'partial',
        timestamp: '2026-05-18T00:00:01.000Z',
        isStreaming: true,
      },
    ];
    const nextMessages: ChatMessage[] = [
      baseMessages[0],
      {
        ...baseMessages[1],
        content: 'partial response keeps growing',
      },
    ];

    expect(getStreamContentKey(nextMessages)).not.toBe(getStreamContentKey(baseMessages));
  });

  it('changes the stream content key when a streamed tool result grows without changing message count', () => {
    const baseMessages: ChatMessage[] = [
      {
        id: 'tool-1',
        type: 'assistant',
        content: '',
        timestamp: '2026-05-18T00:00:01.000Z',
        isToolUse: true,
        toolName: 'Bash',
        toolResult: { content: 'line 1', isError: false },
      },
    ];
    const nextMessages: ChatMessage[] = [
      {
        ...baseMessages[0],
        toolResult: { content: 'line 1\nline 2', isError: false },
      },
    ];

    expect(getStreamContentKey(nextMessages)).not.toBe(getStreamContentKey(baseMessages));
  });
});

describe('didLoadedSessionChange', () => {
  // Guards a real bug: when running session A and switching to session B the
  // `tokenBudget` so A's running-status footer doesn't bleed into B's view.
  // The naive check `currentSessionId !== selectedSession.id` doesn't work
  // because a render-phase mirror eagerly syncs the two on switch, so we
  // detect change off the `lastLoadedSessionKeyRef` instead.

  it('is false on initial load when no previous session has been loaded', () => {
    expect(didLoadedSessionChange(null, 'A:proj:pilotdeck')).toBe(false);
  });

  it('is false when the same session re-enters the effect', () => {
    expect(didLoadedSessionChange('A:proj:pilotdeck', 'A:proj:pilotdeck')).toBe(false);
  });

  it('is true when switching from a previously-loaded session to a different one', () => {
    expect(didLoadedSessionChange('A:proj:pilotdeck', 'B:proj:pilotdeck')).toBe(true);
  });

  it('is true when the same session id is opened under a different project', () => {
    expect(didLoadedSessionChange('A:proj1:pilotdeck', 'A:proj2:pilotdeck')).toBe(true);
  });

  it('is false on the welcome → session_created handoff (lastLoaded was null)', () => {
    // Welcome submit happens with selectedSession=null, so the null branch
    // resets lastLoaded to null. When the real id arrives we don't want to
    // re-clear the composer-set "Processing" status.
    expect(didLoadedSessionChange(null, 'new-session-from-welcome:proj:pilotdeck')).toBe(false);
  });
});

describe('shouldRenderPendingBubble', () => {
  // Guards a real bug: when "session A" is created from welcome submit and
  // the user then clicks "session B" in the sidebar before `session_created`
  // arrives (or in any session switch while the pending bubble is queued),
  // the optimistic "your typed query" bubble must NOT render inside B's
  // transcript. Symptom: the user's latest welcome submit appears at the top
  // of an unrelated session they just opened.

  it('renders on the welcome surface while waiting for session_created', () => {
    expect(shouldRenderPendingBubble(null, null)).toBe(true);
    expect(shouldRenderPendingBubble(null, 'A')).toBe(true);
  });

  it('renders in the exact session the bubble was submitted into', () => {
    expect(shouldRenderPendingBubble('A', 'A')).toBe(true);
  });

  it('does NOT render in a session the bubble was not submitted into', () => {
    expect(shouldRenderPendingBubble('A', 'B')).toBe(false);
  });

  it('does NOT render before session_created stamps the target id', () => {
    // User submitted in welcome, then clicked existing session B before
    // session_created arrived. pendingTargetSessionId is still null because
    // session_created hasn't run yet — bubble must stay invisible in B.
    expect(shouldRenderPendingBubble('B', null)).toBe(false);
  });
});

describe('selectVisibleMessages', () => {
  const user = (id: string): ChatMessage => ({
    id,
    type: 'user',
    content: `User ${id}`,
    timestamp: '2026-08-05T00:00:00.000Z',
  });
  const process = (index: number): ChatMessage => ({
    id: `tool-${index}`,
    type: 'assistant',
    content: '',
    timestamp: '2026-08-05T00:00:01.000Z',
    isToolUse: true,
    toolName: 'Read',
    toolId: `tool-${index}`,
  });

  it('keeps the latest user anchor when a live turn exceeds the window', () => {
    const messages = [user('current'), ...Array.from({ length: 146 }, (_, index) => process(index))];

    const visible = selectVisibleMessages(messages, 100);

    expect(visible).toHaveLength(100);
    expect(visible[0].id).toBe('current');
    expect(visible.at(-1)?.id).toBe('tool-145');
  });

  it('does not alter a window that already contains its latest user anchor', () => {
    const messages = [
      ...Array.from({ length: 40 }, (_, index) => process(index)),
      user('current'),
      ...Array.from({ length: 80 }, (_, index) => process(index + 40)),
    ];

    const visible = selectVisibleMessages(messages, 100);

    expect(visible).toEqual(messages.slice(-100));
  });
});

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
