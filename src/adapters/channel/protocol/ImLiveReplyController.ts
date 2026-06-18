import type { GatewayEvent } from "../../../gateway/index.js";

export type ImLiveReplyHandle = unknown;

export type ImLiveReplyActivityKind = "thinking" | "tool" | "subagent";

export type ImLiveReplyActivity = {
  kind: ImLiveReplyActivityKind;
  text: string;
  elapsedMs: number;
  updateCount: number;
};

export type ImLiveReplyTransportErrorPhase =
  | "send"
  | "edit"
  | "delete"
  | "clear"
  | "activity"
  | "stopActivity";

export type ImLiveReplyTransport<Handle = ImLiveReplyHandle> = {
  send(text: string): Promise<Handle | undefined | false>;
  edit?(handle: Handle, text: string): Promise<void | boolean>;
  delete?(handle: Handle): Promise<void | boolean>;
  clear?(handle: Handle): Promise<void | boolean>;
  pulseActivity?(activity: ImLiveReplyActivity): Promise<void | boolean>;
  stopActivity?(): Promise<void | boolean>;
  maxMessageLength?: number;
  formatText?: (text: string) => string;
};

export type ImLiveReplyControllerOptions<Handle = ImLiveReplyHandle> = {
  transport: ImLiveReplyTransport<Handle>;
  throttleMs?: number;
  bufferThreshold?: number;
  initialThrottleMs?: number;
  initialBufferThreshold?: number;
  turnTimeoutMs?: number;
  activityDelayMs?: number;
  activityUpdateThrottleMs?: number;
  activityMaxUpdates?: number;
  activityTtlMs?: number;
  cursor?: string;
  formatToolError?: (event: GatewayEvent & { type: "tool_call_finished"; ok: false }) => string;
  formatError?: (event: GatewayEvent & { type: "error" }) => string;
  formatActivity?: (activity: Omit<ImLiveReplyActivity, "text">) => string;
  activityOnlyFinalText?: string;
  timeoutFinalText?: string;
  abortFinalText?: string;
  onTransportError?: (error: unknown, phase: ImLiveReplyTransportErrorPhase) => void;
};

type Segment<Handle> = {
  text: string;
  handle?: Handle;
  firstTextAt?: number;
  lastVisibleText: string;
  lastVisibleFinalText: string;
  editDisabled: boolean;
  fallbackPrefix: string;
  final: boolean;
  activityKind: ImLiveReplyActivityKind;
  activityStartedAt: number;
  activityArmed: boolean;
  activityUpdates: number;
  activityVisible: boolean;
  activityDisabled: boolean;
};

const DEFAULT_THROTTLE_MS = 2_000;
const DEFAULT_BUFFER_THRESHOLD = 96;
const DEFAULT_INITIAL_THROTTLE_MS = 800;
const DEFAULT_INITIAL_BUFFER_THRESHOLD = 24;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_ACTIVITY_DELAY_MS = 2_500;
const DEFAULT_ACTIVITY_UPDATE_THROTTLE_MS = 10_000;
const DEFAULT_ACTIVITY_MAX_UPDATES = 6;
const DEFAULT_ACTIVITY_TTL_MS = 120_000;
const DEFAULT_CURSOR = " ▉";
const DEFAULT_ACTIVITY_ONLY_FINAL_TEXT = "处理完成，但没有可见回复。";
const DEFAULT_TIMEOUT_FINAL_TEXT = "处理超时，请重新发送或稍后重试。";
const DEFAULT_ABORT_FINAL_TEXT = "处理已中止，请重新发送或稍后重试。";

export class ImLiveReplyController<Handle = ImLiveReplyHandle> {
  private readonly transport: ImLiveReplyTransport<Handle>;
  private readonly throttleMs: number;
  private readonly bufferThreshold: number;
  private readonly initialThrottleMs: number;
  private readonly initialBufferThreshold: number;
  private readonly turnTimeoutMs: number;
  private readonly activityDelayMs: number;
  private readonly activityUpdateThrottleMs: number;
  private readonly activityMaxUpdates: number;
  private readonly activityTtlMs: number;
  private readonly cursor: string;
  private readonly formatToolError: (event: GatewayEvent & { type: "tool_call_finished"; ok: false }) => string;
  private readonly formatError: (event: GatewayEvent & { type: "error" }) => string;
  private readonly formatActivity: (activity: Omit<ImLiveReplyActivity, "text">) => string;
  private readonly activityOnlyFinalText: string;
  private readonly timeoutFinalText: string;
  private readonly abortFinalText: string;
  private readonly onTransportError?: (error: unknown, phase: ImLiveReplyTransportErrorPhase) => void;

  private currentSegment: Segment<Handle> = createSegment();
  private readonly completedSegments: Array<Segment<Handle>> = [];
  private textTimer: ReturnType<typeof setTimeout> | undefined;
  private turnTimer: ReturnType<typeof setTimeout> | undefined;
  private activityDelayTimer: ReturnType<typeof setTimeout> | undefined;
  private activityUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private lastFlushAt = 0;
  private closed = false;
  private turnTimerArmed = false;

  constructor(options: ImLiveReplyControllerOptions<Handle>) {
    this.transport = options.transport;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.bufferThreshold = options.bufferThreshold ?? DEFAULT_BUFFER_THRESHOLD;
    this.initialThrottleMs = options.initialThrottleMs ?? DEFAULT_INITIAL_THROTTLE_MS;
    this.initialBufferThreshold = options.initialBufferThreshold ?? DEFAULT_INITIAL_BUFFER_THRESHOLD;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.activityDelayMs = options.activityDelayMs ?? DEFAULT_ACTIVITY_DELAY_MS;
    this.activityUpdateThrottleMs = options.activityUpdateThrottleMs ?? DEFAULT_ACTIVITY_UPDATE_THROTTLE_MS;
    this.activityMaxUpdates = options.activityMaxUpdates ?? DEFAULT_ACTIVITY_MAX_UPDATES;
    this.activityTtlMs = options.activityTtlMs ?? DEFAULT_ACTIVITY_TTL_MS;
    this.cursor = options.cursor ?? DEFAULT_CURSOR;
    this.formatToolError = options.formatToolError ?? defaultToolErrorFormatter;
    this.formatError = options.formatError ?? defaultErrorFormatter;
    this.formatActivity = options.formatActivity ?? defaultActivityFormatter;
    this.activityOnlyFinalText = options.activityOnlyFinalText ?? DEFAULT_ACTIVITY_ONLY_FINAL_TEXT;
    this.timeoutFinalText = options.timeoutFinalText ?? DEFAULT_TIMEOUT_FINAL_TEXT;
    this.abortFinalText = options.abortFinalText ?? DEFAULT_ABORT_FINAL_TEXT;
    this.onTransportError = options.onTransportError;
  }

  async handleEvent(event: GatewayEvent): Promise<void> {
    if (this.closed) return;
    this.armTurnTimer();

    switch (event.type) {
      case "turn_started":
        this.armTurnTimer(true);
        this.markActivity("thinking");
        return;
      case "model_request_started":
      case "assistant_thinking_delta":
        this.markActivity("thinking");
        return;
      case "assistant_text_delta":
        await this.append(event.text);
        return;
      case "tool_call_started":
        await this.flushSegment({ finalizeActivityOnly: false });
        this.markActivity("tool");
        return;
      case "tool_call_finished":
        if (!event.ok) {
          await this.append(this.formatToolError(event as GatewayEvent & { type: "tool_call_finished"; ok: false }));
          return;
        }
        this.markActivity("thinking");
        return;
      case "agent_status":
        this.handleAgentStatus(event);
        return;
      case "elicitation_request":
        await this.pauseActivity();
        return;
      case "error":
        await this.append(this.formatError(event));
        return;
      default:
        return;
    }
  }

  async markTimedOut(): Promise<void> {
    await this.finalizeWithTerminalText(this.timeoutFinalText);
  }

  async markAborted(): Promise<void> {
    await this.finalizeWithTerminalText(this.abortFinalText);
  }

  async flushFinal(): Promise<void> {
    if (this.closed) return;
    this.clearTurnTimer();
    await this.flushSegment({ finalizeActivityOnly: true });
    this.closed = true;
    await this.stopNativeActivity();
  }

  async flushSegment(options: { finalizeActivityOnly?: boolean } = {}): Promise<void> {
    const finalizeActivityOnly = options.finalizeActivityOnly ?? true;
    this.clearTextTimer();
    this.clearActivityTimers();
    await this.flushCurrent({ final: true, force: true, finalizeActivityOnly });
    if (
      this.currentSegment.text.trim()
      || this.currentSegment.lastVisibleFinalText.trim()
      || (finalizeActivityOnly && this.currentSegment.lastVisibleText.trim())
    ) {
      this.completedSegments.push(this.currentSegment);
      this.currentSegment = createSegment();
    }
  }

  async pauseActivity(): Promise<void> {
    this.clearActivityTimers();
    await this.stopNativeActivity();
  }

  async clear(): Promise<void> {
    this.clearTextTimer();
    this.clearTurnTimer();
    this.clearActivityTimers();
    await this.waitForInFlight();

    const segments = [...this.completedSegments, this.currentSegment];
    for (const segment of segments) {
      if (!segment.handle) continue;
      try {
        if (this.transport.clear) {
          await this.transport.clear(segment.handle);
        } else if (this.transport.delete) {
          await this.transport.delete(segment.handle);
        }
      } catch (error) {
        this.reportTransportError(error, this.transport.clear ? "clear" : "delete");
      }
    }
    await this.stopNativeActivity();
    this.currentSegment = createSegment();
    this.completedSegments.length = 0;
    this.closed = true;
  }

  private handleAgentStatus(event: GatewayEvent & { type: "agent_status" }): void {
    if (event.event === "subagent_completed") {
      this.markActivity("thinking");
      return;
    }
    if (event.event.startsWith("subagent_")) {
      this.markActivity("subagent");
    }
  }

  private async append(text: string): Promise<void> {
    if (!text) return;
    this.clearActivityTimers();
    await this.stopNativeActivity();

    const liveTextLimit = this.liveTextLimit();
    if (liveTextLimit) {
      let rest = text;
      while (rest) {
        const available = liveTextLimit - this.currentSegment.text.length;
        if (available <= 0) {
          await this.flushSegment();
          continue;
        }

        const piece = rest.length > available ? rest.slice(0, available) : rest;
        await this.appendToCurrentSegment(piece);
        rest = rest.slice(piece.length);
        if (rest) {
          await this.flushSegment();
        }
      }
      return;
    }

    await this.appendToCurrentSegment(text);
  }

  private async appendToCurrentSegment(text: string): Promise<void> {
    if (!text) return;
    const segment = this.currentSegment;
    segment.text += text;
    segment.firstTextAt ??= Date.now();

    if (!this.canSendNonFinalText(segment)) {
      return;
    }

    if (!this.hasVisibleReplyText(segment)) {
      if (segment.text.length >= this.initialBufferThreshold) {
        await this.flushCurrent({ final: false, force: true, finalizeActivityOnly: false });
        return;
      }
      this.scheduleInitialTextFlush(segment);
      return;
    }

    const pendingChars = Math.max(0, segment.text.length - segment.lastVisibleFinalText.length);
    if (pendingChars >= this.bufferThreshold) {
      await this.flushCurrent({ final: false, force: true, finalizeActivityOnly: false });
      return;
    }

    this.scheduleTextFlush(this.throttleMs);
  }

  private canSendNonFinalText(segment: Segment<Handle>): boolean {
    return Boolean(this.transport.edit) && !segment.editDisabled;
  }

  private hasVisibleReplyText(segment: Segment<Handle>): boolean {
    return segment.lastVisibleFinalText.length > 0;
  }

  private liveTextLimit(): number | undefined {
    const max = this.transport.maxMessageLength;
    if (!max) return undefined;
    return Math.max(1, max - this.cursor.length);
  }

  private scheduleInitialTextFlush(segment: Segment<Handle>): void {
    const startedAt = segment.firstTextAt ?? Date.now();
    const delay = Math.max(0, this.initialThrottleMs - (Date.now() - startedAt));
    this.scheduleTextFlush(delay);
  }

  private scheduleTextFlush(delayMs: number): void {
    if (this.textTimer || this.closed) return;
    this.textTimer = setTimeout(() => {
      this.textTimer = undefined;
      void this.flushCurrent({ final: false, force: false, finalizeActivityOnly: false });
    }, delayMs);
    this.textTimer.unref?.();
  }

  private armTurnTimer(force = false): void {
    if (this.closed || this.turnTimeoutMs <= 0) return;
    if (this.turnTimerArmed && !force) return;
    this.clearTurnTimer();
    this.turnTimerArmed = true;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = undefined;
      void this.markTimedOut();
    }, this.turnTimeoutMs);
    this.turnTimer.unref?.();
  }

  private markActivity(kind: ImLiveReplyActivityKind): void {
    if (!this.canUseActivity()) return;
    const segment = this.currentSegment;
    if (segment.activityDisabled || segment.text.trim() || this.hasVisibleReplyText(segment)) return;

    const kindChanged = segment.activityKind !== kind;
    if (kindChanged || !segment.activityArmed) {
      this.clearActivityTimers();
      segment.activityKind = kind;
      segment.activityStartedAt = Date.now();
      segment.activityArmed = true;
      segment.activityUpdates = 0;
    }

    if (segment.activityVisible && !kindChanged) {
      this.scheduleActivityUpdate();
      return;
    }
    this.scheduleActivityDelay();
  }

  private canUseActivity(): boolean {
    return Boolean(this.transport.pulseActivity || this.transport.edit);
  }

  private scheduleActivityDelay(): void {
    if (this.closed || this.activityDelayTimer || !this.canUseActivity()) return;
    const segment = this.currentSegment;
    if (segment.activityDisabled || segment.text.trim() || this.hasVisibleReplyText(segment)) return;
    if (this.activityDelayMs < 0) return;

    this.activityDelayTimer = setTimeout(() => {
      this.activityDelayTimer = undefined;
      void this.flushActivity({ force: true });
    }, this.activityDelayMs);
    this.activityDelayTimer.unref?.();
  }

  private scheduleActivityUpdate(): void {
    if (this.closed || this.activityUpdateTimer || !this.canUseActivity()) return;
    const segment = this.currentSegment;
    if (
      segment.activityDisabled
      || !segment.activityVisible
      || segment.text.trim()
      || this.hasVisibleReplyText(segment)
      || segment.activityUpdates >= this.activityMaxUpdates
    ) {
      return;
    }

    const elapsedMs = Date.now() - segment.activityStartedAt;
    if (elapsedMs >= this.activityTtlMs) return;

    this.activityUpdateTimer = setTimeout(() => {
      this.activityUpdateTimer = undefined;
      void this.flushActivity({ force: false });
    }, this.activityUpdateThrottleMs);
    this.activityUpdateTimer.unref?.();
  }

  private async flushActivity(params: { force: boolean }): Promise<void> {
    await this.runExclusive(() => this.flushActivityNow(params));
  }

  private async flushActivityNow(params: { force: boolean }): Promise<void> {
    const segment = this.currentSegment;
    if (
      this.closed
      || !this.canUseActivity()
      || segment.activityDisabled
      || segment.text.trim()
      || this.hasVisibleReplyText(segment)
      || segment.activityUpdates >= this.activityMaxUpdates
    ) {
      return;
    }

    const elapsedMs = Math.max(0, Date.now() - segment.activityStartedAt);
    if (elapsedMs >= this.activityTtlMs) return;

    const activityBase = {
      kind: segment.activityKind,
      elapsedMs,
      updateCount: segment.activityUpdates + 1,
    };
    const activity: ImLiveReplyActivity = {
      ...activityBase,
      text: this.formatActivity(activityBase),
    };

    if (this.transport.pulseActivity) {
      try {
        const ok = await this.transport.pulseActivity(activity);
        if (ok === false) {
          segment.activityDisabled = true;
          return;
        }
        segment.activityVisible = true;
        segment.activityUpdates += 1;
        this.scheduleActivityUpdate();
      } catch (error) {
        this.reportTransportError(error, "activity");
        segment.activityDisabled = true;
      }
      return;
    }

    if (!this.transport.edit) return;

    const formatted = this.formatForTransport(`${activity.text}${this.cursor}`);
    if (!params.force && formatted === segment.lastVisibleText) {
      segment.activityUpdates += 1;
      this.scheduleActivityUpdate();
      return;
    }

    if (segment.handle) {
      try {
        const ok = await this.transport.edit(segment.handle, formatted);
        if (ok === false) {
          segment.activityDisabled = true;
          segment.editDisabled = true;
          segment.fallbackPrefix = "";
          return;
        }
        segment.lastVisibleText = formatted;
        segment.activityVisible = true;
        segment.activityUpdates += 1;
        this.scheduleActivityUpdate();
      } catch (error) {
        this.reportTransportError(error, "edit");
        segment.activityDisabled = true;
        segment.editDisabled = true;
        segment.fallbackPrefix = "";
      }
      return;
    }

    try {
      const handle = await this.transport.send(formatted);
      if (handle === false || handle === undefined) {
        segment.activityDisabled = true;
        if (handle === undefined) {
          segment.editDisabled = true;
        }
        return;
      }
      segment.handle = handle;
      segment.lastVisibleText = formatted;
      segment.activityVisible = true;
      segment.activityUpdates += 1;
      this.scheduleActivityUpdate();
    } catch (error) {
      this.reportTransportError(error, "send");
      segment.activityDisabled = true;
    }
  }

  private async flushCurrent(params: { final: boolean; force: boolean; finalizeActivityOnly: boolean }): Promise<void> {
    this.clearTextTimer();
    await this.runExclusive(() => this.flushCurrentNow(params));
  }

  private async finalizeWithTerminalText(text: string): Promise<void> {
    if (this.closed) return;
    this.clearTextTimer();
    this.clearTurnTimer();
    this.clearActivityTimers();
    await this.stopNativeActivity();
    await this.waitForInFlight();
    await this.runExclusive(() => this.finalizeWithTerminalTextNow(text));
    this.closed = true;
  }

  private async runExclusive(fn: () => Promise<void>): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }

    const current = fn().finally(() => {
      if (this.inFlight === current) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = current;
    await current;
  }

  private async waitForInFlight(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  private async flushCurrentNow(params: { final: boolean; force: boolean; finalizeActivityOnly: boolean }): Promise<void> {
    const segment = this.currentSegment;
    const finalText = segment.text;
    const hasText = finalText.trim().length > 0;

    if (!hasText) {
      if (params.final && params.finalizeActivityOnly && segment.activityVisible) {
        await this.finalizeActivityOnly(segment);
      }
      return;
    }

    if (!params.final && !this.canSendNonFinalText(segment)) {
      return;
    }

    if (segment.editDisabled) {
      if (params.final) {
        await this.sendFallbackContinuation(segment, finalText);
        segment.final = true;
      }
      return;
    }

    const visibleText = params.final ? finalText : `${finalText}${this.cursor}`;
    const formatted = this.formatForTransport(visibleText);
    if (!params.force && formatted === segment.lastVisibleText) {
      return;
    }

    if (segment.handle && this.transport.edit) {
      try {
        const ok = await this.transport.edit(segment.handle, formatted);
        if (ok === false) {
          await this.enterFallbackMode(segment);
          if (params.final) {
            await this.sendFallbackContinuation(segment, finalText);
            segment.final = true;
          }
          return;
        }
        segment.activityVisible = false;
        segment.lastVisibleText = formatted;
        segment.lastVisibleFinalText = finalText;
        segment.final = params.final;
        this.lastFlushAt = Date.now();
        return;
      } catch (error) {
        this.reportTransportError(error, "edit");
        await this.enterFallbackMode(segment);
        if (params.final) {
          await this.sendFallbackContinuation(segment, finalText);
          segment.final = true;
        }
        return;
      }
    }

    if (segment.handle && !this.transport.edit) {
      segment.editDisabled = true;
      segment.fallbackPrefix = segment.lastVisibleFinalText;
      if (params.final) {
        await this.sendFallbackContinuation(segment, finalText);
        segment.final = true;
      }
      return;
    }

    try {
      const handle = await this.transport.send(formatted);
      if (handle === false) {
        segment.editDisabled = true;
        segment.fallbackPrefix = "";
        if (params.final) {
          await this.sendFallbackContinuation(segment, finalText);
          segment.final = true;
        }
        return;
      }
      segment.handle = handle;
      segment.activityVisible = false;
      segment.lastVisibleText = formatted;
      segment.lastVisibleFinalText = finalText;
      segment.final = params.final;
      if (handle === undefined || !this.transport.edit) {
        segment.editDisabled = true;
        segment.fallbackPrefix = finalText;
      }
      this.lastFlushAt = Date.now();
    } catch (error) {
      this.reportTransportError(error, "send");
      segment.editDisabled = true;
      segment.fallbackPrefix = "";
      if (params.final) {
        await this.sendFallbackContinuation(segment, finalText);
        segment.final = true;
      }
    }
  }

  private async finalizeActivityOnly(segment: Segment<Handle>): Promise<void> {
    await this.stopNativeActivity();
    const formatted = this.formatForTransport(this.activityOnlyFinalText);
    if (!segment.handle || !this.transport.edit || segment.editDisabled) {
      return;
    }

    try {
      const ok = await this.transport.edit(segment.handle, formatted);
      if (ok === false) {
        segment.editDisabled = true;
        return;
      }
      segment.activityVisible = false;
      segment.lastVisibleText = formatted;
      segment.lastVisibleFinalText = formatted;
      segment.final = true;
      this.lastFlushAt = Date.now();
    } catch (error) {
      this.reportTransportError(error, "edit");
      segment.editDisabled = true;
    }
  }

  private async finalizeWithTerminalTextNow(text: string): Promise<void> {
    const segment = this.currentSegment;
    const formatted = this.formatForTransport(text);

    segment.text = "";
    segment.activityVisible = false;
    segment.lastVisibleFinalText = formatted;
    segment.final = true;

    if (segment.handle && this.transport.edit && !segment.editDisabled) {
      try {
        const ok = await this.transport.edit(segment.handle, formatted);
        if (ok !== false) {
          segment.lastVisibleText = formatted;
          this.lastFlushAt = Date.now();
          return;
        }
      } catch (error) {
        this.reportTransportError(error, "edit");
      }
      segment.editDisabled = true;
    }

    if (!segment.handle || !segment.lastVisibleText.trim() || this.transport.edit) {
      try {
        const handle = await this.transport.send(formatted);
        if (handle !== false) {
          segment.handle = handle === undefined ? segment.handle : handle;
          segment.lastVisibleText = formatted;
          this.lastFlushAt = Date.now();
        }
      } catch (error) {
        this.reportTransportError(error, "send");
      }
    }
  }

  private async enterFallbackMode(segment: Segment<Handle>): Promise<void> {
    if (segment.editDisabled) return;
    segment.editDisabled = true;
    segment.fallbackPrefix = segment.lastVisibleFinalText;
    await this.stripCursorBestEffort(segment);
  }

  private async stripCursorBestEffort(segment: Segment<Handle>): Promise<void> {
    if (!segment.handle || !this.transport.edit || !this.cursor) return;
    if (!segment.lastVisibleText.endsWith(this.cursor)) return;

    const clean = segment.lastVisibleText.slice(0, -this.cursor.length);
    try {
      const ok = await this.transport.edit(segment.handle, clean);
      if (ok !== false) {
        segment.lastVisibleText = clean;
      }
    } catch (error) {
      this.reportTransportError(error, "edit");
    }
  }

  private async sendFallbackContinuation(segment: Segment<Handle>, finalText: string): Promise<void> {
    const continuation = continuationText(finalText, segment.fallbackPrefix);
    if (!continuation.trim()) {
      segment.lastVisibleFinalText = finalText;
      return;
    }

    for (const chunk of this.splitForTransport(continuation)) {
      try {
        const handle = await this.transport.send(chunk);
        if (handle === false) {
          return;
        }
        segment.handle = handle;
        segment.activityVisible = false;
        segment.lastVisibleText = chunk;
        segment.lastVisibleFinalText = finalText;
        if (handle !== undefined && this.transport.edit) {
          segment.editDisabled = false;
          segment.fallbackPrefix = finalText;
        }
      } catch (error) {
        this.reportTransportError(error, "send");
        return;
      }
    }
    segment.fallbackPrefix = finalText;
  }

  private formatForTransport(text: string): string {
    const formatted = this.transport.formatText ? this.transport.formatText(text) : text;
    const max = this.transport.maxMessageLength;
    if (!max || formatted.length <= max) {
      return formatted;
    }
    return formatted.slice(0, max);
  }

  private splitForTransport(text: string): string[] {
    const formatted = this.transport.formatText ? this.transport.formatText(text) : text;
    const max = this.transport.maxMessageLength;
    if (!max || formatted.length <= max) {
      return [formatted];
    }

    const chunks: string[] = [];
    let rest = formatted;
    while (rest.length > max) {
      let split = rest.lastIndexOf("\n", max);
      if (split < max / 2) split = rest.lastIndexOf(" ", max);
      if (split < max / 2) split = max;
      chunks.push(rest.slice(0, split));
      rest = rest.slice(split).replace(/^\n+/, "");
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  private clearTextTimer(): void {
    if (!this.textTimer) return;
    clearTimeout(this.textTimer);
    this.textTimer = undefined;
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = undefined;
    }
    this.turnTimerArmed = false;
  }

  private clearActivityTimers(): void {
    if (this.activityDelayTimer) {
      clearTimeout(this.activityDelayTimer);
      this.activityDelayTimer = undefined;
    }
    if (this.activityUpdateTimer) {
      clearTimeout(this.activityUpdateTimer);
      this.activityUpdateTimer = undefined;
    }
  }

  private async stopNativeActivity(): Promise<void> {
    if (!this.transport.stopActivity) return;
    try {
      await this.transport.stopActivity();
    } catch (error) {
      this.reportTransportError(error, "stopActivity");
    }
  }

  private reportTransportError(error: unknown, phase: ImLiveReplyTransportErrorPhase): void {
    this.onTransportError?.(error, phase);
  }
}

function createSegment<Handle>(): Segment<Handle> {
  return {
    text: "",
    lastVisibleText: "",
    lastVisibleFinalText: "",
    editDisabled: false,
    fallbackPrefix: "",
    final: false,
    activityKind: "thinking",
    activityStartedAt: Date.now(),
    activityArmed: false,
    activityUpdates: 0,
    activityVisible: false,
    activityDisabled: false,
  };
}

function continuationText(finalText: string, visiblePrefix: string): string {
  if (!visiblePrefix) return finalText;
  if (!finalText.startsWith(visiblePrefix)) return finalText;
  return finalText.slice(visiblePrefix.length).replace(/^\s+/, "");
}

function defaultToolErrorFormatter(event: GatewayEvent & { type: "tool_call_finished"; ok: false }): string {
  const name = event.toolName ?? event.toolCallId;
  return `\n⚠️ ${name} 执行失败\n`;
}

function defaultErrorFormatter(event: GatewayEvent & { type: "error" }): string {
  return `\n❌ ${event.message}\n`;
}

function defaultActivityFormatter(activity: Omit<ImLiveReplyActivity, "text">): string {
  const base = activity.kind === "tool"
    ? "正在执行工具…"
    : activity.kind === "subagent"
      ? "正在处理子任务…"
      : "正在思考…";
  if (activity.elapsedMs < DEFAULT_ACTIVITY_UPDATE_THROTTLE_MS) {
    return base;
  }
  return `${base}（${Math.round(activity.elapsedMs / 1000)}s）`;
}
