// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatScrollbars } from './useChatScrollbars';

function Harness({ visible = true }: { visible?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useChatScrollbars(ref);
  return visible ? <div ref={ref} data-testid="chat"><pre data-testid="code" /></div> : null;
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('reveals only the scrolling target, extends activity and clears idle timers', () => {
  vi.useFakeTimers();
  const view = render(<Harness />);
  const chat = view.getByTestId('chat'), code = view.getByTestId('code');
  expect(chat.hasAttribute('data-chat-scrolling')).toBe(false);
  fireEvent.scroll(code);
  expect(code.hasAttribute('data-chat-scrolling')).toBe(true);
  expect(chat.hasAttribute('data-chat-scrolling')).toBe(false);
  act(() => vi.advanceTimersByTime(600));
  fireEvent.scroll(code);
  fireEvent.scroll(chat);
  act(() => vi.advanceTimersByTime(600));
  expect(code.hasAttribute('data-chat-scrolling')).toBe(true);
  act(() => vi.advanceTimersByTime(200));
  expect(code.hasAttribute('data-chat-scrolling')).toBe(false);
  expect(chat.hasAttribute('data-chat-scrolling')).toBe(false);
  fireEvent.scroll(code);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(code.hasAttribute('data-chat-scrolling')).toBe(false);
});

it('attaches after the welcome view mounts the conversation and retains activity through renders', () => {
  vi.useFakeTimers();
  const view = render(<Harness visible={false} />);
  view.rerender(<Harness />);
  const chat = view.getByTestId('chat');
  fireEvent.scroll(chat);
  view.rerender(<Harness />);
  expect(chat.hasAttribute('data-chat-scrolling')).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  view.rerender(<Harness visible={false} />);
  expect(vi.getTimerCount()).toBe(0);
});
