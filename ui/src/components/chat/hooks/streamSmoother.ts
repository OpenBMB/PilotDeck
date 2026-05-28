type FrameHandle = number;

type SmoothTextStreamOptions = {
  emit: (content: string) => void;
  finalize?: () => void;
  now?: () => number;
  scheduleFrame?: (callback: () => void) => FrameHandle;
  cancelFrame?: (handle: FrameHandle) => void;
  frameMs?: number;
  fallbackFrameMs?: number;
  targetLagMs?: number;
  maxLagMs?: number;
  minCharsPerFrame?: number;
  maxCharsPerFrame?: number;
};

export type SmoothTextStreamSnapshot = {
  targetLength: number;
  renderedLength: number;
  averageCharsPerSecond: number;
  pendingChars: number;
  isScheduled: boolean;
};

const DEFAULT_FRAME_MS = 33;
const DEFAULT_TARGET_LAG_MS = 360;
const DEFAULT_MAX_LAG_MS = 650;
const DEFAULT_MIN_CHARS_PER_FRAME = 1;
const DEFAULT_MAX_CHARS_PER_FRAME = 36;
const DEFAULT_AVERAGE_CHARS_PER_SECOND = 90;
const DEFAULT_FALLBACK_FRAME_MS = 80;
const RATE_ALPHA = 0.22;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smooth(previous: number, next: number): number {
  return previous * (1 - RATE_ALPHA) + next * RATE_ALPHA;
}

function isPreferredBoundary(char: string): boolean {
  return /[\s,.;:!?，。！？、；：）\])}]/.test(char);
}

function findBoundary(content: string, minLength: number, desiredLength: number, maxLength: number): number {
  const safeMax = clamp(maxLength, minLength, content.length);
  const safeDesired = clamp(desiredLength, minLength, safeMax);
  const backwardLimit = Math.max(minLength, safeDesired - 12);
  for (let index = safeDesired; index >= backwardLimit; index -= 1) {
    if (isPreferredBoundary(content[index - 1] || '')) {
      return index;
    }
  }

  const forwardLimit = Math.min(safeMax, safeDesired + 12);
  for (let index = safeDesired + 1; index <= forwardLimit; index += 1) {
    if (isPreferredBoundary(content[index - 1] || '')) {
      return index;
    }
  }

  return safeDesired;
}

export class SmoothTextStream {
  private targetContent = '';
  private renderedContent = '';
  private frame: FrameHandle | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChunkAtMs: number | null = null;
  private lastFrameAtMs: number | null = null;
  private averageCharsPerSecond = DEFAULT_AVERAGE_CHARS_PER_SECOND;

  constructor(private readonly options: SmoothTextStreamOptions) {}

  append(text: string): void {
    if (!text) return;

    const now = this.now();
    if (this.lastChunkAtMs != null) {
      const intervalSeconds = clamp((now - this.lastChunkAtMs) / 1000, 0.016, 1.5);
      const currentRate = text.length / intervalSeconds;
      this.averageCharsPerSecond = smooth(this.averageCharsPerSecond, currentRate);
    }
    this.lastChunkAtMs = now;
    this.targetContent += text;
    this.emitInitialContent();
    this.schedulePump();
  }

  flush(finalize = false): void {
    this.cancelScheduledFrame();
    if (this.renderedContent !== this.targetContent) {
      this.renderedContent = this.targetContent;
      this.options.emit(this.renderedContent);
    }
    if (finalize) {
      this.options.finalize?.();
      this.targetContent = '';
      this.renderedContent = '';
      this.lastChunkAtMs = null;
      this.lastFrameAtMs = null;
    }
  }

  cancel(): void {
    this.cancelScheduledFrame();
  }

  getSnapshot(): SmoothTextStreamSnapshot {
    const pendingChars = this.targetContent.length - this.renderedContent.length;
    return {
      targetLength: this.targetContent.length,
      renderedLength: this.renderedContent.length,
      averageCharsPerSecond: this.averageCharsPerSecond,
      pendingChars,
      isScheduled: this.frame != null,
    };
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }

  private scheduleFrame(callback: () => void): FrameHandle {
    if (this.options.scheduleFrame) {
      return this.options.scheduleFrame(callback);
    }
    return window.requestAnimationFrame(callback);
  }

  private cancelFrame(handle: FrameHandle): void {
    if (this.options.cancelFrame) {
      this.options.cancelFrame(handle);
      return;
    }
    window.cancelAnimationFrame(handle);
  }

  private cancelScheduledFrame(): void {
    if (this.frame != null) {
      this.cancelFrame(this.frame);
      this.frame = null;
    }
    this.cancelFallbackTimer();
  }

  private cancelFallbackTimer(): void {
    if (this.fallbackTimer == null) return;
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private schedulePump(): void {
    if (this.frame != null) return;
    this.frame = this.scheduleFrame(() => this.pump());
    this.scheduleFallbackPump();
  }

  private scheduleFallbackPump(): void {
    // Browser rAF can be delayed or paused by WebView/tab throttling. The first
    // chunk is emitted synchronously; this timeout keeps the rest moving without
    // giving up smooth per-frame rendering when rAF is healthy.
    if (this.options.scheduleFrame || this.fallbackTimer != null || typeof window === 'undefined') {
      return;
    }
    this.fallbackTimer = window.setTimeout(() => {
      this.fallbackTimer = null;
      if (this.frame == null) return;
      this.cancelFrame(this.frame);
      this.frame = null;
      this.pump();
    }, this.options.fallbackFrameMs ?? DEFAULT_FALLBACK_FRAME_MS);
  }

  private emitInitialContent(): void {
    if (this.renderedContent.length > 0 || this.targetContent.length === 0) {
      return;
    }

    const charsToRender = this.getCharsForFrame(this.targetContent.length);
    const minNextLength = Math.min(this.targetContent.length, this.minCharsPerFrame);
    const maxNextLength = Math.min(this.targetContent.length, this.maxCharsPerFrame);
    const nextLength = findBoundary(
      this.targetContent,
      minNextLength,
      charsToRender,
      maxNextLength,
    );
    this.renderedContent = this.targetContent.slice(0, nextLength);
    this.options.emit(this.renderedContent);
  }

  private pump(): void {
    this.frame = null;
    this.cancelFallbackTimer();

    const now = this.now();
    if (this.lastFrameAtMs != null && now - this.lastFrameAtMs < this.frameMs * 0.8) {
      this.schedulePump();
      return;
    }
    this.lastFrameAtMs = now;

    const remaining = this.targetContent.length - this.renderedContent.length;
    if (remaining <= 0) return;

    const charsToRender = this.getCharsForFrame(remaining);
    const minNextLength = this.renderedContent.length + charsToRender;
    const maxNextLength = Math.min(
      this.targetContent.length,
      this.renderedContent.length + this.maxCharsPerFrame,
    );
    const nextLength = findBoundary(
      this.targetContent,
      this.renderedContent.length + this.minCharsPerFrame,
      minNextLength,
      maxNextLength,
    );
    this.renderedContent = this.targetContent.slice(0, nextLength);
    this.options.emit(this.renderedContent);

    if (this.renderedContent.length < this.targetContent.length) {
      this.schedulePump();
    }
  }

  private get frameMs(): number {
    return this.options.frameMs ?? DEFAULT_FRAME_MS;
  }

  private get targetLagMs(): number {
    return this.options.targetLagMs ?? DEFAULT_TARGET_LAG_MS;
  }

  private get maxLagMs(): number {
    return Math.max(this.targetLagMs, this.options.maxLagMs ?? DEFAULT_MAX_LAG_MS);
  }

  private get minCharsPerFrame(): number {
    return this.options.minCharsPerFrame ?? DEFAULT_MIN_CHARS_PER_FRAME;
  }

  private get maxCharsPerFrame(): number {
    return this.options.maxCharsPerFrame ?? DEFAULT_MAX_CHARS_PER_FRAME;
  }

  private getCharsForFrame(remaining: number): number {
    const targetPendingChars = Math.max(
      this.minCharsPerFrame,
      Math.round(this.averageCharsPerSecond * (this.targetLagMs / 1000)),
    );
    const maxPendingChars = Math.max(
      targetPendingChars,
      Math.round(this.averageCharsPerSecond * (this.maxLagMs / 1000)),
    );
    const baseChars = Math.ceil(this.averageCharsPerSecond * (this.frameMs / 1000));
    const excessChars = Math.max(0, remaining - targetPendingChars);
    const catchUpChars = remaining > maxPendingChars ? Math.ceil((remaining - maxPendingChars) / 4) : 0;
    const desired = Math.max(this.minCharsPerFrame, baseChars, Math.ceil(excessChars / 10), catchUpChars);
    return clamp(desired, this.minCharsPerFrame, Math.min(this.maxCharsPerFrame, remaining));
  }
}
