import type { GatewayEvent } from "../../../gateway/index.js";
import { isVisibleFailureStatusDetail } from "../../../status/agentStatus.js";
import { closeCodeFence, codeFenceContinuation, codeFenceSplitPoint } from "./ImCodeFences.js";

export type ImLiveReplyHandle = unknown;

export type ImLiveReplyActivityKind = "thinking" | "tool" | "subagent";

export type ImLiveReplyActivity = {
  kind: ImLiveReplyActivityKind;
  text: string;
  elapsedMs: number;
  updateCount: number;
  detail?: string;
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
  /**
   * Platform cap on how many times one sent message may be edited (Feishu: 20).
   * The controller keeps one edit in reserve for the final text and continues
   * streaming in a fresh message once the budget is spent, so long replies do
   * not freeze half-way when the platform starts rejecting edits.
   */
  maxEditsPerMessage?: number;
  formatText?: (text: string) => string;
  /** Keep code blocks intact when a Markdown reply spans several messages. */
  preserveCodeFences?: boolean;
};

export type ImLiveReplyControllerOptions<Handle = ImLiveReplyHandle> = {
  transport: ImLiveReplyTransport<Handle>;
  throttleMs?: number;
  bufferThreshold?: number;
  initialThrottleMs?: number;
  initialBufferThreshold?: number;
  /** Minimum gap between two live (non-final) edits once text is visible. */
  minEditIntervalMs?: number;
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
  codeFencePrefix: string;
  handle?: Handle;
  firstTextAt?: number;
  lastVisibleText: string;
  lastVisibleFinalText: string;
  editCount: number;
  editDisabled: boolean;
  fallbackPrefix: string;
  final: boolean;
  activityKind: ImLiveReplyActivityKind;
  activityStartedAt: number;
  activityArmed: boolean;
  activityUpdates: number;
  activityVisible: boolean;
  activityDisabled: boolean;
  activityDetail?: string;
};

const DEFAULT_THROTTLE_MS = 2_000;
const DEFAULT_BUFFER_THRESHOLD = 96;
const DEFAULT_INITIAL_THROTTLE_MS = 800;
const DEFAULT_INITIAL_BUFFER_THRESHOLD = 24;
const DEFAULT_MIN_EDIT_INTERVAL_MS = 1_000;
/** Upper bound on how much `formatText` can grow raw text (`&` → `&amp;`). */
const MAX_FORMAT_EXPANSION = 6;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_ACTIVITY_DELAY_MS = 2_500;
const DEFAULT_ACTIVITY_UPDATE_THROTTLE_MS = 10_000;
const DEFAULT_ACTIVITY_MAX_UPDATES = 6;
const DEFAULT_ACTIVITY_TTL_MS = 120_000;
const DEFAULT_CURSOR = " ▉";
const DEFAULT_ACTIVITY_ONLY_FINAL_TEXT = "处理完成，但没有可见回复。";
const DEFAULT_TIMEOUT_FINAL_TEXT = "处理超时，请重新发送或稍后重试。";
const DEFAULT_ABORT_FINAL_TEXT = "处理已中止，请重新发送或稍后重试。";
const VISIBLE_FAILURE_STATUS_EVENTS = new Set([
  "model_empty_response_exhausted",
  "max_turns_reached",
  "max_output_recovery_exhausted",
  "model_request_failed",
  "tool_call_recovery_exhausted",
  "tool_error_loop",
  "lifecycle_blocked",
  "turn_failed",
  "turn_timeout",
  "gateway_submit_failed",
  "session_busy",
  "gateway_bridge_error",
  "gateway_stream_ended_without_completion",
  "web_http_request_failed",
  "project_unavailable",
  "config_invalid",
  "gateway_unavailable",
  "channel_submit_failed",
  "subagent_failed",
  "content_filter_stop",
  "unknown_finish_reason",
]);
const WARNING_STATUS_EVENTS = new Set([
  ...VISIBLE_FAILURE_STATUS_EVENTS,
  "structured_output_completed",
  "turn_aborted",
]);

export class ImLiveReplyController<Handle = ImLiveReplyHandle> {
  private readonly transport: ImLiveReplyTransport<Handle>;
  private readonly throttleMs: number;
  private readonly bufferThreshold: number;
  private readonly initialThrottleMs: number;
  private readonly initialBufferThreshold: number;
  private readonly minEditIntervalMs: number;
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
  private textTimerDueAt = 0;
  private turnTimer: ReturnType<typeof setTimeout> | undefined;
  private activityDelayTimer: ReturnType<typeof setTimeout> | undefined;
  private activityUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly liveFlushQueued = new Set<Segment<Handle>>();
  private finalizing = false;
  private lastFlushAt = 0;
  private closed = false;
  private turnTimerArmed = false;
  private hasVisibleFailureStatus = false;

  constructor(options: ImLiveReplyControllerOptions<Handle>) {
    this.transport = options.transport;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.bufferThreshold = options.bufferThreshold ?? DEFAULT_BUFFER_THRESHOLD;
    this.initialThrottleMs = options.initialThrottleMs ?? DEFAULT_INITIAL_THROTTLE_MS;
    this.initialBufferThreshold = options.initialBufferThreshold ?? DEFAULT_INITIAL_BUFFER_THRESHOLD;
    this.minEditIntervalMs = Math.max(0, options.minEditIntervalMs ?? DEFAULT_MIN_EDIT_INTERVAL_MS);
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
        this.hasVisibleFailureStatus = false;
        this.armTurnTimer(true);
        this.markActivity("thinking");
        return;
      case "model_request_started":
        this.markActivity("thinking");
        return;
      case "assistant_thinking_delta":
        this.markActivity("thinking", event.text);
        return;
      case "assistant_text_delta":
        await this.append(event.text);
        return;
      case "tool_call_started":
        if (this.shouldFlushBeforeToolBoundary()) {
          // Finalize the text written so far in the background; the agent's
          // event stream should not wait on an IM round trip at every tool call.
          this.finalizeSegmentInBackground();
        } else {
          this.clearTextTimer();
        }
        this.markActivity("tool", event.name);
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
        if (this.hasVisibleFailureStatus) {
          return;
        }
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
    this.finalizing = true;
    try {
      await this.flushCurrent({ final: true, force: true, finalizeActivityOnly });
    } finally {
      this.finalizing = false;
    }
    if (
      this.currentSegment.text.trim()
      || this.currentSegment.lastVisibleFinalText.trim()
      || (finalizeActivityOnly && this.currentSegment.lastVisibleText.trim())
    ) {
      const previous = this.currentSegment;
      this.completedSegments.push(previous);
      this.currentSegment = this.nextSegment(previous);
    }
  }

  async pauseActivity(): Promise<void> {
    if (this.closed) return;
    // Seal even text whose throttle timer has not fired. The final flush is a
    // barrier behind earlier segments, so prompts cannot overtake buffered text.
    await this.flushSegment({ finalizeActivityOnly: false });
    await this.stopNativeActivity();
  }

  /** Stop timers and discard queued delivery work without sending more text. */
  cancel(): void {
    this.closed = true;
    this.clearTextTimer();
    this.clearTurnTimer();
    this.clearActivityTimers();
    this.liveFlushQueued.clear();
  }

  async resumeActivity(
    kind: ImLiveReplyActivityKind = "thinking",
    options: { immediate?: boolean } = {},
  ): Promise<void> {
    if (this.closed) return;
    this.clearActivityTimers();
    const segment = this.currentSegment;
    segment.activityKind = kind;
    segment.activityStartedAt = Date.now();
    segment.activityArmed = true;
    segment.activityUpdates = 0;
    if (options.immediate === true) {
      await this.flushActivity({ force: true });
      return;
    }
    this.scheduleActivityDelay();
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
    const isVisibleFailure = event.detail?.visible !== false
      && (VISIBLE_FAILURE_STATUS_EVENTS.has(event.event) || isVisibleFailureStatusDetail(event.detail));
    if (isVisibleFailure) {
      this.hasVisibleFailureStatus = true;
    }
    if (event.event === "model_empty_response_exhausted") {
      const detailMessage = typeof event.detail?.message === "string" ? event.detail.message : undefined;
      void this.append(`\n⚠️ ${detailMessage ?? "The model returned empty content repeatedly, so this turn has stopped. Try again later or increase max output tokens."}\n`);
      return;
    }
    if (event.event === "max_turns_reached") {
      const detailMessage = typeof event.detail?.message === "string" ? event.detail.message : undefined;
      void this.append(`\n⚠️ ${detailMessage ?? "Reached the maximum number of turns, so this turn has stopped. Increase maxTurns or split the task into smaller steps and try again."}\n`);
      return;
    }
    if (WARNING_STATUS_EVENTS.has(event.event) || isVisibleFailureStatusDetail(event.detail)) {
      const detailMessage = typeof event.detail?.message === "string" ? event.detail.message : undefined;
      if (detailMessage) {
        void this.append(`\n⚠️ ${detailMessage}\n`);
      }
      return;
    }
    if (event.event === "subagent_completed") {
      this.markActivity("thinking");
      return;
    }
    if (event.event.startsWith("subagent_")) {
      const detail = typeof event.detail?.subagentType === "string" ? event.detail.subagentType : undefined;
      this.markActivity("subagent", detail);
    }
  }

  private async append(text: string): Promise<void> {
    if (!text) return;
    if (this.transport.edit) {
      this.clearActivityTimers();
      await this.stopNativeActivity();
    }
    if (this.closed) return;

    if (this.editBudgetExhausted(this.currentSegment) && this.hasVisibleReplyText(this.currentSegment)) {
      this.rollOverSegment();
    }
    const liveTextLimit = this.liveTextLimit();
    if (liveTextLimit) {
      let rest = text;
      while (rest) {
        const available = liveTextLimit - this.currentSegment.codeFencePrefix.length - this.currentSegment.text.length;
        let piece = rest.slice(0, Math.max(0, available));
        piece = this.fitFormattedPiece(this.currentSegment.codeFencePrefix + this.currentSegment.text, piece);
        if (this.transport.preserveCodeFences && piece.length < rest.length) {
          const base = this.currentSegment.codeFencePrefix + this.currentSegment.text;
          const split = codeFenceSplitPoint(base + rest, base.length + piece.length);
          if (split > base.length) {
            piece = rest.slice(0, split - base.length);
          } else if (split > this.currentSegment.codeFencePrefix.length && split < base.length
            && !this.currentSegment.editDisabled && !this.liveFlushQueued.has(this.currentSegment) && !this.inFlight) {
            // The preferred line boundary (or an unfinished fence header) can
            // be in a previous delta. Move the tail before sealing the segment.
            const carried = base.slice(split);
            this.currentSegment.text = this.currentSegment.text.slice(0, split - this.currentSegment.codeFencePrefix.length);
            this.rollOverSegment();
            rest = carried + rest;
            continue;
          }
        }
        if (!piece) {
          if (this.currentSegment.text) {
            this.rollOverSegment();
            continue;
          }
          // Not even one character fits once formatted; keep making progress
          // and let the transport-side truncation handle the pathological case.
          piece = rest.slice(0, 1);
        }
        this.appendToCurrentSegment(piece);
        rest = rest.slice(piece.length);
        if (rest) {
          this.rollOverSegment();
        }
      }
      return;
    }

    this.appendToCurrentSegment(text);
  }

  /**
   * Buffer text and schedule a live update. Never waits on the transport:
   * channels await `handleEvent` for every streamed delta, so blocking here
   * would cap reply throughput at one chunk per IM round trip.
   */
  private appendToCurrentSegment(text: string): void {
    if (!text) return;
    const segment = this.currentSegment;
    segment.text += text;
    segment.firstTextAt ??= Date.now();

    if (!this.canSendNonFinalText(segment)) {
      return;
    }

    if (!this.hasVisibleReplyText(segment)) {
      if (segment.text.length >= this.initialBufferThreshold) {
        this.scheduleTextFlush(0);
        return;
      }
      this.scheduleInitialTextFlush(segment);
      return;
    }

    const pendingChars = Math.max(0, segment.text.length - segment.lastVisibleFinalText.length);
    if (pendingChars >= this.bufferThreshold) {
      this.scheduleTextFlush(this.remainingEditInterval());
      return;
    }

    this.scheduleTextFlush(this.throttleMs);
  }

  /**
   * Start a new segment (a new IM message) right away and finalize the
   * previous one behind any transport work already queued. Swapping
   * synchronously keeps text that arrives meanwhile out of the old message.
   */
  private rollOverSegment(): void {
    this.clearTextTimer();
    this.clearActivityTimers();
    const segment = this.currentSegment;
    this.completedSegments.push(segment);
    this.currentSegment = this.nextSegment(segment);
    this.runInBackground(
      () => this.flushCurrentNow({ final: true, force: true, finalizeActivityOnly: false }, segment),
      "edit",
    );
  }

  private nextSegment(previous: Segment<Handle>): Segment<Handle> {
    const next = createSegment<Handle>();
    if (this.transport.preserveCodeFences) {
      next.codeFencePrefix = codeFenceContinuation(previous.codeFencePrefix + previous.text);
    }
    return next;
  }

  private replyText(segment: Segment<Handle>, text: string): string {
    const raw = segment.codeFencePrefix + text;
    return this.transport.preserveCodeFences ? closeCodeFence(raw) : raw;
  }

  private finalizeSegmentInBackground(): void {
    const segment = this.currentSegment;
    if (segment.text.trim() || segment.lastVisibleFinalText.trim()) {
      this.rollOverSegment();
      return;
    }
    this.clearTextTimer();
    this.clearActivityTimers();
  }

  /**
   * Queue one live (non-final) flush. While one is already waiting, further
   * requests are absorbed: it reads the newest segment text when it runs, so a
   * backlog collapses into a single edit.
   */
  private requestLiveFlush(): void {
    const segment = this.currentSegment;
    if (this.liveFlushQueued.has(segment) || this.closed) return;
    this.liveFlushQueued.add(segment);
    // Coalesce only within this segment. Looking up currentSegment at execution
    // time can send a later segment ahead of an earlier queued finalization.
    this.runInBackground(async () => {
      this.liveFlushQueued.delete(segment);
      if (this.closed || this.finalizing || segment.final) return;
      if (this.hasVisibleReplyText(segment)) {
        const wait = this.remainingEditInterval();
        if (wait > 0) {
          if (segment === this.currentSegment) this.scheduleTextFlush(wait);
          return;
        }
      }
      await this.flushCurrentNow({ final: false, force: false, finalizeActivityOnly: false }, segment);
    }, "edit");
  }

  private remainingEditInterval(): number {
    return Math.max(0, this.lastFlushAt + this.minEditIntervalMs - Date.now());
  }

  private editBudgetExhausted(segment: Segment<Handle>): boolean {
    const max = this.transport.maxEditsPerMessage;
    if (!max || max <= 0 || segment.handle === undefined || segment.editDisabled) return false;
    // Keep the last edit for the final text (cursor removed).
    return segment.editCount >= max - 1;
  }

  private runInBackground(fn: () => Promise<void>, phase: ImLiveReplyTransportErrorPhase): void {
    void this.runExclusive(fn).catch((error: unknown) => {
      this.reportTransportError(error, phase);
    });
  }

  private canSendNonFinalText(segment: Segment<Handle>): boolean {
    return Boolean(this.transport.edit) && !segment.editDisabled;
  }

  private hasVisibleReplyText(segment: Segment<Handle>): boolean {
    return segment.lastVisibleFinalText.length > 0;
  }

  private liveTextLimit(): number | undefined {
    if (!this.transport.edit) return undefined;
    const max = this.transport.maxMessageLength;
    if (!max) return undefined;
    // Reserve the newline + closing fence before accepting raw text.
    return Math.max(1, max - this.cursor.length - (this.transport.preserveCodeFences ? 4 : 0));
  }

  /**
   * The live text limit is measured on raw text, but transports with
   * `formatText` may expand it (Slack escapes `<`, `>` and `&` into entities).
   * Return the longest prefix of `piece` whose formatted segment, cursor
   * included, still fits in one message, so the overflow rolls into the next
   * message instead of being cut off by `formatForTransport`.
   */
  private fitFormattedPiece(base: string, piece: string): string {
    const max = this.transport.maxMessageLength;
    if (!max || !piece || (!this.transport.formatText && !this.transport.preserveCodeFences)) return piece;
    // Formatting the whole segment on every delta is wasted work while it is
    // far below the limit; no formatter expands text more than this.
    if ((base.length + piece.length + this.cursor.length + (this.transport.preserveCodeFences ? 4 : 0)) * MAX_FORMAT_EXPANSION <= max) return piece;
    const fits = (length: number) => {
      const raw = `${base}${piece.slice(0, length)}`;
      const text = this.transport.preserveCodeFences ? closeCodeFence(raw) : raw;
      return this.formattedLength(`${text}${this.cursor}`) <= max;
    };
    if (fits(piece.length)) return piece;
    let low = 0;
    let high = piece.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return low > 0 && fits(low) ? piece.slice(0, low) : "";
  }

  private formattedLength(text: string): number {
    return this.transport.formatText ? this.transport.formatText(text).length : text.length;
  }

  private scheduleInitialTextFlush(segment: Segment<Handle>): void {
    const startedAt = segment.firstTextAt ?? Date.now();
    const delay = Math.max(0, this.initialThrottleMs - (Date.now() - startedAt));
    this.scheduleTextFlush(delay);
  }

  private scheduleTextFlush(delayMs: number): void {
    if (this.closed || this.finalizing) return;
    const delay = Math.max(0, delayMs);
    const dueAt = Date.now() + delay;
    if (this.textTimer) {
      // An earlier deadline (e.g. the buffer filled up) wins over a lazy throttle.
      if (this.textTimerDueAt <= dueAt) return;
      clearTimeout(this.textTimer);
    }
    this.textTimerDueAt = dueAt;
    this.textTimer = setTimeout(() => {
      this.textTimer = undefined;
      this.requestLiveFlush();
    }, delay);
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

  private markActivity(kind: ImLiveReplyActivityKind, detail?: string): void {
    if (!this.canUseActivity()) return;
    const segment = this.currentSegment;
    if (segment.activityDisabled || this.shouldSuppressActivityForText(segment)) return;

    const kindChanged = segment.activityKind !== kind;
    if (kindChanged || !segment.activityArmed) {
      this.clearActivityTimers();
      segment.activityKind = kind;
      segment.activityStartedAt = Date.now();
      segment.activityArmed = true;
      segment.activityUpdates = 0;
    }
    if (detail?.trim()) {
      segment.activityDetail = detail.trim().slice(0, 160);
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
    if (segment.activityDisabled || this.shouldSuppressActivityForText(segment)) return;
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
      || this.shouldSuppressActivityForText(segment)
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
    const segment = this.currentSegment;
    await this.runExclusive(() => this.flushActivityNow(params, segment));
  }

  private async flushActivityNow(params: { force: boolean }, segment: Segment<Handle>): Promise<void> {
    if (
      this.closed
      || segment !== this.currentSegment
      || segment.final
      || !this.canUseActivity()
      || segment.activityDisabled
      || this.shouldSuppressActivityForText(segment)
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
      ...(segment.activityDetail ? { detail: segment.activityDetail } : {}),
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
      if (this.editBudgetExhausted(segment)) {
        // Do not spend the reserved final edit on a status refresh.
        return;
      }
      try {
        const ok = await this.transport.edit(segment.handle, formatted);
        if (ok === false) {
          segment.activityDisabled = true;
          segment.editDisabled = true;
          segment.fallbackPrefix = "";
          return;
        }
        segment.editCount += 1;
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
    const segment = this.currentSegment;
    await this.runExclusive(() => this.flushCurrentNow(params, segment));
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

  private runExclusive(fn: () => Promise<void>): Promise<void> {
    // Publish the tail synchronously: every operation has a fixed FIFO slot,
    // including segment finalization and permission-prompt barriers.
    const previous = this.inFlight ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (!this.closed) await fn();
    }).finally(() => {
      if (this.inFlight === current) this.inFlight = undefined;
    });
    this.inFlight = current;
    return current;
  }

  private async waitForInFlight(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  private async flushCurrentNow(
    params: { final: boolean; force: boolean; finalizeActivityOnly: boolean },
    segment: Segment<Handle> = this.currentSegment,
  ): Promise<void> {
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

    if (!params.final && this.editBudgetExhausted(segment)) {
      return;
    }

    if (params.final && !this.transport.edit && !segment.handle) {
      await this.sendFinalChunks(segment, finalText);
      segment.final = true;
      return;
    }

    if (segment.editDisabled) {
      if (params.final) {
        await this.sendFallbackContinuation(segment, finalText);
        segment.final = true;
      }
      return;
    }

    const replyText = this.replyText(segment, finalText);
    const visibleText = params.final ? replyText : `${replyText}${this.cursor}`;
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
        segment.editCount += 1;
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
      if (!this.transport.edit && segment.activityVisible) {
        try {
          const handle = await this.transport.send(formatted);
          if (handle !== false) {
            segment.handle = handle === undefined ? segment.handle : handle;
            segment.lastVisibleText = formatted;
            segment.lastVisibleFinalText = formatted;
            segment.final = true;
            this.lastFlushAt = Date.now();
          }
        } catch (error) {
          this.reportTransportError(error, "send");
        }
      }
      return;
    }

    try {
      const ok = await this.transport.edit(segment.handle, formatted);
      if (ok === false) {
        segment.editDisabled = true;
        return;
      }
      segment.editCount += 1;
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
          segment.editCount += 1;
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
          if (handle !== undefined) segment.editCount = 0;
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
    if (this.closed || !segment.handle || !this.transport.edit || !this.cursor) return;
    if (!segment.lastVisibleText.endsWith(this.cursor)) return;

    const clean = segment.lastVisibleText.slice(0, -this.cursor.length);
    try {
      const ok = await this.transport.edit(segment.handle, clean);
      if (ok !== false) {
        segment.editCount += 1;
        segment.lastVisibleText = clean;
      }
    } catch (error) {
      this.reportTransportError(error, "edit");
    }
  }

  private async sendFallbackContinuation(segment: Segment<Handle>, finalText: string): Promise<void> {
    let continuation = continuationText(finalText, segment.fallbackPrefix);
    if (this.transport.preserveCodeFences) {
      const delivered = finalText.startsWith(segment.fallbackPrefix) ? segment.fallbackPrefix : "";
      const prefix = codeFenceContinuation(segment.codeFencePrefix + delivered);
      continuation = finalText.slice(delivered.length);
      if (continuation) continuation = closeCodeFence(prefix + continuation);
    }
    if (!continuation.trim()) {
      segment.lastVisibleFinalText = finalText;
      return;
    }

    for (const chunk of this.splitForTransport(continuation)) {
      if (this.closed) return;
      try {
        const handle = await this.transport.send(chunk);
        if (handle === false) {
          return;
        }
        segment.handle = handle;
        segment.editCount = 0;
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

  private shouldFlushBeforeToolBoundary(): boolean {
    const segment = this.currentSegment;
    return Boolean(this.transport.edit || segment.handle || this.hasVisibleReplyText(segment));
  }

  private shouldSuppressActivityForText(segment: Segment<Handle>): boolean {
    if (!this.transport.edit && this.transport.pulseActivity) {
      return false;
    }
    return Boolean(segment.text.trim() || this.hasVisibleReplyText(segment));
  }

  private async sendFinalChunks(segment: Segment<Handle>, finalText: string): Promise<void> {
    for (const chunk of this.splitForTransport(finalText)) {
      if (this.closed) return;
      try {
        const handle = await this.transport.send(chunk);
        if (handle === false) {
          return;
        }
        segment.handle = handle === undefined ? segment.handle : handle;
        segment.activityVisible = false;
        segment.lastVisibleText = chunk;
        segment.lastVisibleFinalText = finalText;
        this.lastFlushAt = Date.now();
      } catch (error) {
        this.reportTransportError(error, "send");
        return;
      }
    }
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
    codeFencePrefix: "",
    lastVisibleText: "",
    lastVisibleFinalText: "",
    editCount: 0,
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
  const provider = event.providerError;
  const providerLines = provider
    ? [
        "",
        "Provider error:",
        provider.provider ? `- provider: ${provider.provider}` : undefined,
        provider.status !== undefined ? `- status: ${provider.status}` : undefined,
        provider.code ? `- code: ${provider.code}` : undefined,
        provider.message ? `- message: ${provider.message}` : undefined,
        provider.raw ? `- raw: ${provider.raw}` : undefined,
      ].filter((line): line is string => line !== undefined).join("\n")
    : "";
  return `\n❌ ${event.message}${providerLines}\n`;
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
