import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTypewriter } from './useTypewriter';

let frames: Map<number, FrameRequestCallback>;
let next: number;
let time: number;
function advance(milliseconds: number, hz = 60) {
  const end = time + milliseconds;
  while (time < end - 0.01) {
    time = Math.min(end, time + 1000 / hz);
    act(() => {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((callback) => callback(time));
    });
  }
}
beforeEach(() => {
  frames = new Map(); next = 0; time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('stream text presentation', () => {
  it('resumes after Strict Mode replays the effects', () => {
    const view = renderHook(() => useTypewriter('Live response', true), { wrapper: StrictMode });
    advance(1000);
    expect(view.result.current).toBe('Live response');
  });
  it('uses elapsed time instead of display refresh rate', () => {
    const a = renderHook(() => useTypewriter('x'.repeat(40), true, 4));
    advance(100, 60); const at60 = a.result.current.length; a.unmount();
    const b = renderHook(() => useTypewriter('x'.repeat(40), true, 4));
    advance(100, 120);
    expect(Math.abs(b.result.current.length - at60)).toBeLessThanOrEqual(1);
  });
  it('drains outstanding text on completion without dumping the remaining block', () => {
    const fullText = 'x'.repeat(1000);
    const view = renderHook(({ streaming }) => useTypewriter(fullText, streaming), { initialProps: { streaming: true } });
    advance(30); const before = view.result.current;
    view.rerender({ streaming: false });
    expect(view.result.current).toBe(before);
    advance(50);
    expect(view.result.current.length).toBeGreaterThan(before.length);
    expect(view.result.current.length).toBeLessThan(fullText.length);
    advance(1000);
    expect(view.result.current).toBe(fullText);
    expect(frames.size).toBe(0);
  });
  it('shows history immediately and cancels pending animation when unmounted', () => {
    const history = renderHook(() => useTypewriter('Saved response', false));
    expect(history.result.current).toBe('Saved response');
    const live = renderHook(() => useTypewriter('Live response', true));
    live.unmount();
    expect(frames.size).toBe(0);
  });
});
