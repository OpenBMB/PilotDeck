// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatHistorySearch } from './useChatHistorySearch';
import type { SearchableChatMessageInput } from './chatHistorySearchUtils';

vi.mock('../../contexts/FindShortcutContext', () => ({ useRegisterFindShortcutTarget: () => {} }));
const messages: SearchableChatMessageInput[] = [{
  messageKey: 'target', message: { id: 'target', type: 'assistant', timestamp: '2026-09-05T00:00:00Z', content: '[Guide](https://example.com/unique-reference)', isStreaming: false },
}];
const heights = [100];
const loadAllMessages = () => {};
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let search: ReturnType<typeof useChatHistorySearch>;
function Harness({ pending }: { pending: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  search = useChatHistorySearch({
    scrollContainerRef: ref, keyedMessages: messages, measuredItemHeights: heights,
    allMessagesLoaded: true, hasMoreMessages: false, loadAllMessages, sessionId: 'session',
  });
  return <div ref={ref} data-testid="viewport">
    <div className="chat-message" data-message-key="target">
      <div data-chat-search-render-pending={pending ? 'true' : undefined}><a href="https://example.com/unique-reference">Guide</a></div>
    </div>
  </div>;
}
async function flushFrame() {
  await act(async () => {});
  await act(async () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  });
}
beforeEach(() => {
  frames = new Map(); frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('search fallback rendering readiness', () => {
  it.each([false, true])('reacts to completion with no text-node change (cancelled: %s)', async (cancelled) => {
    const { getByTestId, rerender } = render(<Harness pending />);
    const viewport = getByTestId('viewport');
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo;
    act(() => { search.openSearch(); search.setQuery('unique-reference'); });
    await flushFrame();
    // Backend completion alone is insufficient while displayed text is pending.
    expect(scrollTo).not.toHaveBeenCalled();
    if (cancelled) fireEvent.wheel(viewport, { deltaY: -30 });
    rerender(<Harness pending={false} />);
    await flushFrame();
    expect(viewport.querySelector('mark')).toBeNull();
    expect(scrollTo).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    // Later DOM updates must not restart successful or cancelled navigation.
    act(() => { viewport.querySelector('a')!.textContent = 'Updated guide label'; });
    await flushFrame();
    expect(scrollTo).toHaveBeenCalledTimes(cancelled ? 0 : 1);
  });
});
