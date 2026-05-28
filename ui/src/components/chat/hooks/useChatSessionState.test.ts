import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types/types';
import {
  BOTTOM_FOLLOW_THRESHOLD_PX,
  didLoadedSessionChange,
  getStreamContentKey,
  isScrollNearBottom,
  shouldRenderPendingBubble,
} from './useChatSessionState';

describe('useChatSessionState scroll helpers', () => {
  it('uses a wider bottom threshold for streaming follow mode', () => {
    expect(isScrollNearBottom(805, 1000, 100)).toBe(true);
    expect(isScrollNearBottom(803, 1000, 100)).toBe(false);
    expect(BOTTOM_FOLLOW_THRESHOLD_PX).toBe(96);
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
