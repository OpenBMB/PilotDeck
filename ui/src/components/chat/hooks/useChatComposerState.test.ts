import { describe, expect, it } from 'vitest';
import {
  resolvePreparedInputQueueTarget,
  shouldCycleRunModeOnKeyDown,
  shouldRoutePreparedInputThroughQueue,
} from './useChatComposerState';

function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey };
}

describe('useChatComposerState keyboard shortcuts', () => {
  it('uses Shift+Tab to cycle run mode when no completion menu is open', () => {
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: false,
      showCommandMenu: false,
    })).toBe(true);
  });

  it('does not cycle run mode for plain Tab or while menus are open', () => {
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab'), {
      showFileDropdown: false,
      showCommandMenu: false,
    })).toBe(false);
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: true,
      showCommandMenu: false,
    })).toBe(false);
    expect(shouldCycleRunModeOnKeyDown(keyEvent('Tab', true), {
      showFileDropdown: false,
      showCommandMenu: true,
    })).toBe(false);
  });
});

describe('useChatComposerState input routing', () => {
  it('routes every concrete existing session through the server queue', () => {
    expect(shouldRoutePreparedInputThroughQueue('web:s_existing')).toBe(true);
    expect(shouldRoutePreparedInputThroughQueue(null)).toBe(false);
  });

  it('does not mistake a stale current session for the target of a new idle chat', () => {
    expect(resolvePreparedInputQueueTarget({
      submitTargetSessionId: null,
      currentSessionId: 'web:s_previous',
      pendingViewSessionId: null,
      pendingSessionId: null,
      requiresExistingQueueTarget: false,
    })).toBeUndefined();
  });

  it('uses the pinned current session while a starting or active turn requires queuing', () => {
    expect(resolvePreparedInputQueueTarget({
      submitTargetSessionId: null,
      currentSessionId: 'web:s_active',
      pendingViewSessionId: null,
      pendingSessionId: null,
      requiresExistingQueueTarget: true,
    })).toBe('web:s_active');
  });
});
