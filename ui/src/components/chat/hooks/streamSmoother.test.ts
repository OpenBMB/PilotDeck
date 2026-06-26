import { describe, expect, it, vi } from 'vitest';
import { SmoothTextStream } from './streamSmoother';

function createManualFrameScheduler(onFrame?: () => void) {
  let nextId = 1;
  const queue: Array<{ id: number; callback: () => void; cancelled: boolean }> = [];

  return {
    scheduleFrame(callback: () => void): number {
      const id = nextId;
      nextId += 1;
      queue.push({ id, callback, cancelled: false });
      return id;
    },
    cancelFrame(id: number) {
      const item = queue.find((entry) => entry.id === id);
      if (item) item.cancelled = true;
    },
    runNext() {
      const item = queue.shift();
      if (item && !item.cancelled) {
        onFrame?.();
        item.callback();
      }
    },
    drain(limit = 80) {
      let count = 0;
      while (queue.length > 0 && count < limit) {
        this.runNext();
        count += 1;
      }
      return count;
    },
    get size() {
      return queue.filter((item) => !item.cancelled).length;
    },
  };
}

describe('SmoothTextStream', () => {
  it('renders a large chunk over many bounded frame updates', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    const text = 'abcdefghijklmnopqrstuvwxyz '.repeat(8);
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
      frameMs: 33,
      minCharsPerFrame: 3,
      maxCharsPerFrame: 18,
    });

    stream.append(text);

    expect(emitted.length).toBe(0);
    expect(stream.getSnapshot().targetLength).toBe(text.length);

    scheduler.runNext();
    scheduler.runNext();

    expect(emitted.length).toBeGreaterThanOrEqual(2);
    expect(emitted[0].length).toBeGreaterThan(0);
    expect(emitted[0].length).toBeLessThan(text.length);

    for (let index = 1; index < emitted.length; index += 1) {
      const delta = emitted[index].length - emitted[index - 1].length;
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(2);
    }

    scheduler.drain(200);

    expect(emitted[emitted.length - 1]).toBe(text);
    expect(stream.getSnapshot().renderedLength).toBe(text.length);
  });

  it('keeps appended text buffered until scheduled frame updates render it', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
    });

    stream.append('abcd');
    now += 40;
    stream.append('x'.repeat(80));

    expect(emitted).toHaveLength(0);
    expect(stream.getSnapshot().averageCharsPerSecond).toBe(120);
    expect(stream.getSnapshot().pendingChars).toBe(84);

    scheduler.runNext();

    expect(emitted).toEqual(['ab']);
    expect(stream.getSnapshot().pendingChars).toBe(82);
  });

  it('emits small frame-sized slices while streaming gradually', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
      frameMs: 33,
      minCharsPerFrame: 6,
      maxCharsPerFrame: 12,
    });

    stream.append('hello world, next sentence.');
    scheduler.runNext();

    expect(emitted[0]).toBe('he');
    expect(emitted[0].length).toBeLessThanOrEqual(2);
  });

  it('flushes all buffered content and finalizes immediately', () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    let finalized = 0;
    const stream = new SmoothTextStream({
      emit: (content) => emitted.push(content),
      finalize: () => {
        finalized += 1;
      },
      scheduleFrame: (callback) => scheduler.scheduleFrame(callback),
      cancelFrame: (handle) => scheduler.cancelFrame(handle),
      now: () => now,
    });

    stream.append('streaming output');
    stream.flush(true);

    expect(emitted.at(-1)).toBe('streaming output');
    expect(finalized).toBe(1);
    expect(stream.getSnapshot().targetLength).toBe(0);
    expect(stream.getSnapshot().renderedLength).toBe(0);
    expect(scheduler.size).toBe(0);
  });

  it('uses the fallback timer when the scheduled frame does not run promptly', () => {
    vi.useFakeTimers();
    const emitted: string[] = [];

    try {
      const stream = new SmoothTextStream({
        emit: (content) => emitted.push(content),
        fallbackFrameMs: 10,
      });

      stream.append('abcdefghijklmnopqrstuvwxyz '.repeat(4));

      expect(emitted.length).toBe(0);
      vi.advanceTimersByTime(10);

      expect(emitted.length).toBe(1);
      vi.advanceTimersByTime(10);
      expect(emitted.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
