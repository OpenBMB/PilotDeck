// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import { useLiveReplyKeys } from './useLiveReplyKeys';
import { getIntrinsicMessageKey } from '../chat/utils/messageKeys';
afterEach(cleanup);
it('animates only new live replies, including a batched final frame, and resets across sessions', () => {
  const history: ChatMessage = { id: 'old', type: 'assistant', content: 'History', timestamp: '' };
  const reply = { ...history, id: 'new', content: 'Final answer' };
  const view = renderHook(({ messages, working, scope }) => useLiveReplyKeys(messages, working, scope), {
    initialProps: { messages: [history], working: true, scope: 'a' },
  });
  expect(view.result.current.size).toBe(0);
  const earlier = { ...history, id: 'earlier', content: 'Earlier history' };
  view.rerender({ messages: [earlier, history], working: true, scope: 'a' });
  expect(view.result.current.size).toBe(0);
  view.rerender({ messages: [earlier, history, reply], working: false, scope: 'a' });
  expect(view.result.current.has(getIntrinsicMessageKey(reply)!)).toBe(true);
  expect(view.result.current.has(getIntrinsicMessageKey(history)!)).toBe(false);
  const latest = { ...reply, id: 'latest' };
  view.rerender({ messages: [earlier, history, reply, latest], working: true, scope: 'a' });
  expect([...view.result.current]).toEqual([getIntrinsicMessageKey(latest)]);
  view.rerender({ messages: [reply], working: false, scope: 'b' });
  expect(view.result.current.size).toBe(0);
});
