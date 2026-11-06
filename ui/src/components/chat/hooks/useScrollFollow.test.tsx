// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adjustScrollLayout, notifyScrollLayout, useScrollFollow } from './useScrollFollow';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let observers: Set<ResizeObserverCallback>;
let api: ReturnType<typeof useScrollFollow>;

function Harness({ enabled = true, scope = 'one', version = 0 }: { enabled?: boolean; scope?: string; version?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  api = useScrollFollow({ containerRef: ref, enabled, scopeKey: scope, contentSelector: '[data-chat-scroll-content]' });
  return <div ref={ref} data-testid="viewport" data-stream-scroll-viewport>
    <div data-chat-scroll-content><div data-message-key="old">Earlier</div><div data-message-key="reading">Reading {version}</div></div>
  </div>;
}

function setup() {
  const view = render(<Harness />);
  const node = view.getByTestId('viewport');
  const metrics = { top: 0, height: 1000, viewport: 200 };
  Object.defineProperties(node, {
    scrollTop: { configurable: true, get: () => metrics.top, set: (value: number) => { metrics.top = Math.max(0, Math.min(value, metrics.height - metrics.viewport)); } },
    scrollHeight: { configurable: true, get: () => metrics.height },
    clientHeight: { configurable: true, get: () => metrics.viewport },
  });
  flush();
  fireEvent.scroll(node);
  return { view, node, metrics };
}
function flush() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}
function resize() { act(() => observers.forEach((callback) => callback([], {} as ResizeObserver))); }

beforeEach(() => {
  frames = new Map(); nextFrame = 0; observers = new Set();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('reader-owned scroll following', () => {
  it.each([-1, 1])('ignores a stale scrollend before the next gesture moves (%s)', direction => {
    const { node, metrics } = setup();
    const row = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
    row.getBoundingClientRect = () => ({ top: 400 - metrics.top, bottom: 1000 - metrics.top }) as DOMRect;
    node.scrollTop = 500;
    act(() => api.pauseAt('reading'));
    fireEvent.wheel(node, { deltaY: direction * 30 });
    node.scrollTop += direction * 30; fireEvent.scroll(node);
    fireEvent.wheel(node, { deltaY: direction * 30 });
    fireEvent(node, new Event('scrollend'));
    node.scrollTop += direction * 30; fireEvent.scroll(node);
    resize(); flush();
    expect(node.scrollTop).toBe(500 + direction * 60);
  });

  it.each(['scrollend', 'idle'])('stops attributing later layout movement to a finished gesture (%s)', ending => {
    const { node, metrics } = setup();
    const row = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
    row.getBoundingClientRect = () => ({ top: 400 - metrics.top, bottom: 1000 - metrics.top }) as DOMRect;
    node.scrollTop = 500;
    act(() => api.pauseAt('reading'));
    fireEvent.wheel(node, { deltaY: -30 });
    node.scrollTop = 470; fireEvent.scroll(node);
    if (ending === 'scrollend') fireEvent(node, new Event('scrollend'));
    const now = vi.spyOn(Date, 'now');
    if (ending === 'idle') now.mockReturnValue(Date.now() + 1000);
    try {
      node.scrollTop = 440; fireEvent.scroll(node);
      resize(); flush();
      expect(node.scrollTop).toBe(470);
    } finally { now.mockRestore(); }
  });

  it.each([-1, 1])('does not consume virtual layout corrections as wheel displacement (%s)', direction => {
    const { node, metrics } = setup();
    let inserted = 0;
    const row = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
    row.getBoundingClientRect = () => ({ top: 750 + inserted - metrics.top, bottom: 1000 + inserted - metrics.top }) as DOMRect;
    node.scrollTop = 500;
    act(() => api.pauseAt('reading'));
    fireEvent.wheel(node, { deltaY: direction * 30 });
    inserted = direction * 100; metrics.height += inserted;
    act(() => { adjustScrollLayout(node, 500 + inserted); notifyScrollLayout(node); });
    fireEvent.scroll(node);
    expect(node.scrollTop).toBe(500 + inserted);
    node.scrollTop += direction * 30;
    fireEvent.scroll(node); resize(); flush();
    expect(node.scrollTop).toBe(500 + inserted + direction * 30);
  });

  it.each([-1, 1])('retains every native scroll frame from one wheel gesture (%s)', direction => {
    const { node, metrics, view } = setup();
    const row = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
    row.getBoundingClientRect = () => ({ top: 400 - metrics.top, bottom: 1000 - metrics.top }) as DOMRect;
    node.scrollTop = 500;
    act(() => api.pauseAt('reading'));
    fireEvent.wheel(node, { deltaY: direction * 120 });
    for (let frame = 1; frame <= 4; frame++) {
      node.scrollTop = 500 + direction * frame * 30;
      fireEvent.scroll(node);
      view.rerender(<Harness version={frame} />);
      resize(); flush();
      expect(node.scrollTop).toBe(500 + direction * frame * 30);
    }
    fireEvent(node, new Event('scrollend'));
    expect(api.isPaused).toBe(true);
  });

  it('reuses the reading row across updates and reacquires it after virtual remount', () => {
    const { node, metrics } = setup();
    let inserted = 0;
    const row = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
    row.getBoundingClientRect = () => ({ top: 750 + inserted - metrics.top, bottom: 1000 + inserted - metrics.top }) as DOMRect;
    act(() => api.pauseAt('reading'));
    const queries = vi.spyOn(node, 'querySelectorAll');
    inserted = 40; metrics.height += 40;
    resize();
    expect(node.scrollTop).toBe(840);
    expect(queries.mock.calls.filter(([selector]) => selector === '[data-message-key]')).toHaveLength(0);
    const replacement = row.cloneNode(true) as HTMLElement;
    replacement.getBoundingClientRect = row.getBoundingClientRect;
    row.replaceWith(replacement);
    inserted = 90; metrics.height += 50;
    resize();
    expect(node.scrollTop).toBe(890);
    expect(queries.mock.calls.filter(([selector]) => selector === '[data-message-key]')).toHaveLength(1);
    queries.mockRestore();
  });
  it('anchors a search result inside an expanded process while content above the result resizes', () => {
    const { node, metrics } = setup();
    const process = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
    const result = document.createElement('div');
    result.dataset.messageKey = 'search-result';
    process.appendChild(result);
    let inserted = 0;
    process.getBoundingClientRect = () => ({ top: 100 - metrics.top, bottom: 1000 + inserted - metrics.top }) as DOMRect;
    result.getBoundingClientRect = () => ({ top: 550 + inserted - metrics.top, bottom: 580 + inserted - metrics.top }) as DOMRect;
    node.scrollTop = 500;
    act(() => api.pauseAt('search-result'));
    expect(api.getReadingAnchor()?.key).toBe('search-result');
    inserted = 120; metrics.height += 120;
    resize(); flush();
    expect(node.scrollTop).toBe(620);
    expect(result.getBoundingClientRect().top).toBe(50);
  });

  it('cancels a queued follow on a small upward gesture, before React commits', () => {
    const { node, metrics, view } = setup();
    resize();
    fireEvent.wheel(node, { deltaY: -5 });
    node.scrollTop -= 5;
    fireEvent.scroll(node);
    metrics.height += 50;
    view.rerender(<Harness version={1} />);
    resize(); flush();
    expect(node.scrollTop).toBe(795);
    expect(api.isPaused).toBe(true);
  });

  it.each(['scroll-first', 'resize-first'])('preserves user displacement when layout grows in the same frame (%s)', (order) => {
    const { node, metrics } = setup();
    const row = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
    row.getBoundingClientRect = () => ({ top: 750 - metrics.top, bottom: 1000 - metrics.top }) as DOMRect;
    fireEvent.wheel(node, { deltaY: -30 });
    node.scrollTop = 770;
    metrics.height += 50;
    if (order === 'resize-first') resize();
    fireEvent.scroll(node);
    resize(); flush();
    expect(node.scrollTop).toBe(770);
    expect(api.isPaused).toBe(true);
  });

  it('combines an upward gesture with newly inserted history in the same frame', () => {
    const { node, metrics } = setup();
    let inserted = 0;
    const row = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
    row.getBoundingClientRect = () => ({ top: 750 + inserted - metrics.top, bottom: 1000 + inserted - metrics.top }) as DOMRect;
    fireEvent.wheel(node, { deltaY: -30 });
    node.scrollTop = 770; inserted = 100; metrics.height += 150;
    resize(); fireEvent.scroll(node); flush();
    expect(node.scrollTop).toBe(870);
    expect(row.getBoundingClientRect().top).toBe(-20);
  });

  it('ignores upward input when neither viewport has scrollable content', () => {
    const { node, metrics } = setup();
    metrics.height = metrics.viewport; node.scrollTop = 0;
    fireEvent.scroll(node); resize(); flush();
    fireEvent.wheel(node, { deltaY: -30 });
    expect(api.isPaused).toBe(false);
    expect(api.canReturnToLatest).toBe(false);
    metrics.height += 500; resize(); flush();
    expect(node.scrollTop).toBe(500);
  });

  it('positions history once with automatic following disabled, then retains the reader', () => {
    const { view, node, metrics } = setup();
    view.rerender(<Harness enabled={false} />);
    node.scrollTop = 0;
    act(() => api.scheduleInitialPosition());
    view.rerender(<Harness enabled={false} version={1} />);
    flush();
    expect(node.scrollTop).toBe(800);
    // Finish the initial virtual measurement frames before later content arrives.
    flush(); flush(); flush(); flush();
    metrics.height += 100; resize(); flush();
    expect(node.scrollTop).toBe(800);
  });

  it('lets user input cancel an initial position queued with automatic following disabled', () => {
    const { view, node } = setup();
    view.rerender(<Harness enabled={false} />);
    act(() => api.scheduleInitialPosition());
    fireEvent.wheel(node, { deltaY: -30 });
    node.scrollTop = 770; fireEvent.scroll(node); flush();
    expect(node.scrollTop).toBe(770);
  });

  it('resumes only when the reader scrolls down to the actual bottom', () => {
    const { node, metrics } = setup();
    fireEvent.wheel(node, { deltaY: -30 });
    node.scrollTop = 770; fireEvent.scroll(node);
    fireEvent.wheel(node, { deltaY: 20 }); node.scrollTop = 790; fireEvent.scroll(node);
    resize(); flush();
    expect(node.scrollTop).toBe(790);
    fireEvent.wheel(node, { deltaY: 20 }); node.scrollTop = 800; fireEvent.scroll(node);
    metrics.height += 40;
    resize(); flush();
    expect(node.scrollTop).toBe(840);
    expect(api.isPaused).toBe(false);
  });

  it('does not resume after layout shrink clamps the paused viewport to the bottom', () => {
    const { node, metrics } = setup();
    fireEvent.wheel(node, { deltaY: -200 }); node.scrollTop = 600; fireEvent.scroll(node);
    metrics.height = 800; fireEvent.scroll(node);
    metrics.height = 1100; resize(); flush();
    expect(node.scrollTop).toBe(600);
    expect(api.isPaused).toBe(true);
  });

  it('does not replay an unreachable anchor correction after content shrinks and regrows', () => {
    const { node, metrics } = setup();
    const row = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
    row.getBoundingClientRect = () => ({ top: 750 - metrics.top, bottom: 1000 - metrics.top }) as DOMRect;
    fireEvent.wheel(node, { deltaY: -30 }); node.scrollTop = 770; fireEvent.scroll(node);
    metrics.height = 900; node.scrollTop = 700;
    resize(); fireEvent.scroll(node);
    metrics.height = 1100; resize(); flush();
    expect(node.scrollTop).toBe(700);
    expect(api.isPaused).toBe(true);
  });

  it('pauses the conversation while an inner thinking viewport is being read', () => {
    const { node, metrics } = setup();
    const inner = document.createElement('div'); inner.dataset.streamScrollViewport = ''; node.append(inner);
    Object.defineProperties(inner, { scrollHeight: { value: 500 }, clientHeight: { value: 200 }, scrollTop: { value: 300 } });
    fireEvent.wheel(inner, { deltaY: -10 });
    fireEvent.wheel(inner, { deltaY: 10 });
    metrics.height += 100; resize(); flush();
    expect(node.scrollTop).toBe(800);
    expect(api.isPaused).toBe(true);
    act(() => api.scrollToBottom());
    expect(node.scrollTop).toBe(900);
  });

  it.each(['keyboard', 'touch', 'scrollbar'])('cancels pending scroll for %s input', (kind) => {
    const { node, metrics } = setup(); resize();
    if (kind === 'keyboard') fireEvent.keyDown(node, { key: 'PageUp' });
    if (kind === 'scrollbar') fireEvent.pointerDown(node);
    if (kind === 'touch') {
      fireEvent.touchStart(node, { touches: [{ clientY: 20 }] });
      fireEvent.touchMove(node, { touches: [{ clientY: 40 }] });
    }
    node.scrollTop = 700; fireEvent.scroll(node);
    metrics.height += 30; resize(); flush();
    expect(node.scrollTop).toBe(700);
  });

  it('preserves the visible message when history grows above and streaming grows below', () => {
    const { view, node, metrics } = setup();
    let addedHistory = 0;
    const rows = node.querySelectorAll<HTMLElement>('[data-message-key]');
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: addedHistory + index * 300 - metrics.top, bottom: addedHistory + (index + 1) * 300 - metrics.top }) as DOMRect;
    });
    fireEvent.wheel(node, { deltaY: -450 }); node.scrollTop = 350; fireEvent.scroll(node);
    addedHistory = 100; metrics.height += 250;
    view.rerender(<Harness version={2} />); resize(); flush();
    expect(node.scrollTop).toBe(450);
    expect(rows[1].getBoundingClientRect().top).toBe(-50);
  });

  it('cancels queued work when disabled or unmounted', () => {
    const { view, node, metrics } = setup();
    resize(); metrics.height += 100;
    view.rerender(<Harness enabled={false} />); flush();
    expect(node.scrollTop).toBe(800);
    view.unmount();
    expect(frames.size).toBe(0);
  });
});

it.each(['resize-first', 'scroll-first'])('keeps following layout-only clamping without user input (%s)', order => {
  const { node, metrics } = setup();
  metrics.height = 700;
  node.scrollTop = 500;
  if (order === 'resize-first') { resize(); flush(); }
  fireEvent.scroll(node);
  metrics.height = 1200;
  resize(); flush();
  expect(api.isPaused).toBe(false);
  expect(api.canReturnToLatest).toBe(false);
  expect(node.scrollTop).toBe(1000);
});

it('ignores non-user upward scroll events after layout measurements have settled', () => {
  const { node, metrics } = setup();
  node.scrollTop = 680;
  fireEvent.scroll(node);
  resize(); flush();
  expect(api.isPaused).toBe(false);
  expect(node.scrollTop).toBe(metrics.height - metrics.viewport);
});

it('preserves an anchor when virtual measurements redistribute rows without resizing the content', () => {
  const { node, metrics } = setup();
  node.scrollTop = 500;
  let shifted = 0;
  const row = node.querySelector<HTMLElement>('[data-message-key="reading"]')!;
  row.getBoundingClientRect = () => ({ top: 750 + shifted - metrics.top, bottom: 1000 + shifted - metrics.top }) as DOMRect;
  act(() => api.pauseAt('reading'));
  const offset = row.getBoundingClientRect().top;
  shifted = 4;
  act(() => notifyScrollLayout(node));
  expect(row.getBoundingClientRect().top).toBe(offset);
  expect(api.isPaused).toBe(true);
});

it('settles the initial virtual tail with following disabled, then preserves the reader', () => {
  const { node, metrics, view } = setup();
  view.rerender(<Harness enabled={false} />);
  act(() => api.scheduleInitialPosition());
  flush();
  metrics.height += 356;
  resize(); flush();
  expect(node.scrollTop).toBe(metrics.height - metrics.viewport);
  flush(); flush(); flush(); flush();
  const reading = node.scrollTop;
  metrics.height += 100;
  resize(); flush();
  expect(node.scrollTop).toBe(reading);
});

it('pauses before intentional disclosure expansion and retains that ownership through layout changes', () => {
  const { node, metrics } = setup();
  const row = node.querySelector('[data-message-key="reading"]')!;
  const button = document.createElement('button');
  button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'details');
  row.append(button);
  fireEvent.click(button);
  expect(api.isPaused).toBe(true);
  metrics.height += 500;
  resize(); flush();
  expect(node.scrollTop).toBe(800);
  act(() => api.scrollToBottom());
  metrics.height += 50;
  resize(); flush();
  expect(node.scrollTop).toBe(1350);
  expect(api.isPaused).toBe(false);
});
