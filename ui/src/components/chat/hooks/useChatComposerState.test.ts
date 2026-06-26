import { describe, expect, it } from 'vitest';
import type { QueuedChatInput } from '../types/types';
import {
  canQueueInputForTest,
  getNextDispatchableQueuedInputForTest,
  insertComposerTokenForTest,
  moveQueuedInputForTest,
  settleQueuedDispatchForTest,
  shouldCycleRunModeOnKeyDown,
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

describe('useChatComposerState composer token insertion', () => {
  it('inserts a separating space before toolbar slash commands after text', () => {
    expect(insertComposerTokenForTest('please review', 13, 13, '/')).toEqual({
      nextValue: 'please review /',
      nextCursor: 15,
    });
  });

  it('keeps slash commands tight at the start or after existing whitespace', () => {
    expect(insertComposerTokenForTest('', 0, 0, '/')).toEqual({
      nextValue: '/',
      nextCursor: 1,
    });
    expect(insertComposerTokenForTest('please ', 7, 7, '/')).toEqual({
      nextValue: 'please /',
      nextCursor: 8,
    });
  });

  it('replaces selected text when inserting composer tokens', () => {
    expect(insertComposerTokenForTest('please replace this', 7, 14, '@')).toEqual({
      nextValue: 'please @ this',
      nextCursor: 8,
    });
  });
});

describe('useChatComposerState queued input ordering', () => {
  const makeQueue = (): QueuedChatInput[] => [
    { id: 'a', content: 'first', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 1 },
    { id: 'b', content: 'second', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 2 },
    { id: 'c', content: 'third', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 3 },
  ];

  it('moves queued inputs up and down', () => {
    expect(moveQueuedInputForTest(makeQueue(), 'b', -1).map((item) => item.id)).toEqual(['b', 'a', 'c']);
    expect(moveQueuedInputForTest(makeQueue(), 'b', 1).map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });

  it('keeps order when moving past queue boundaries or missing ids', () => {
    expect(moveQueuedInputForTest(makeQueue(), 'a', -1).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moveQueuedInputForTest(makeQueue(), 'c', 1).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moveQueuedInputForTest(makeQueue(), 'x', 1).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('useChatComposerState queued input eligibility', () => {
  const makeQueue = (): QueuedChatInput[] => [
    { id: 'a', content: 'first', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 1 },
    { id: 'b', content: 'second', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 2 },
  ];

  it('allows text-only queued input', () => {
    expect(canQueueInputForTest('next step', 0)).toBe(true);
  });

  it('rejects blank queued input', () => {
    expect(canQueueInputForTest('   \n\t', 0)).toBe(false);
  });

  it('rejects queued input with attachments', () => {
    expect(canQueueInputForTest('next step', 1)).toBe(false);
  });

  it('pauses on an invalid first queued item instead of skipping it', () => {
    const queue: QueuedChatInput[] = [
      { id: 'a', content: '   ', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 1 },
      { id: 'b', content: 'send me later', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 2 },
    ];

    expect(getNextDispatchableQueuedInputForTest(queue)).toBeNull();
  });

  it('returns the first valid queued item for dispatch', () => {
    const queue: QueuedChatInput[] = [
      { id: 'a', content: 'send me next', files: [], thinkingMode: 'none', targetSessionId: 's1', createdAt: 1 },
    ];

    expect(getNextDispatchableQueuedInputForTest(queue)?.id).toBe('a');
  });

  it('keeps a queued input visible when dispatch fails', () => {
    const queue = makeQueue();

    expect(settleQueuedDispatchForTest(queue, 'a', false)).toEqual(queue);
  });

  it('removes only the dispatched queued input after successful dispatch', () => {
    expect(settleQueuedDispatchForTest(makeQueue(), 'a', true).map((item) => item.id)).toEqual(['b']);
    expect(settleQueuedDispatchForTest(makeQueue(), 'b', true).map((item) => item.id)).toEqual(['a']);
  });
});
