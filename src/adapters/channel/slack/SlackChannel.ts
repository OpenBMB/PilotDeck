import WebSocket from "ws";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { Gateway, GatewayChannelKey, GatewayEvent } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import type { ChannelRuntimeStatusReporter } from "../protocol/ChannelRuntimeStatus.js";
import { executeChannelCommand, resolveCommand } from "../protocol/ChannelCommandRegistry.js";
import { ImChatSessionState } from "../protocol/ImChatSessionState.js";
import { deliverChatCronResult } from "../protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImLiveReplyController, type ImLiveReplyTransport } from "../protocol/ImLiveReplyController.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import {
  ENGLISH_LIVE_REPLY_TEXT,
  ENGLISH_NEW_SESSION_TEXT,
  ENGLISH_SUBMIT_FAILED_TEXT,
} from "../protocol/englishLiveReplyText.js";
import { SlackSessionMapper, type SlackSessionMapperState } from "./SlackSessionMapper.js";

/**
 * Slack channel over Socket Mode, implemented directly on the Web API + a
 * WebSocket so it needs no extra SDK and no public URL.
 *
 * Required app setup: Socket Mode enabled with an app-level token
 * (`xapp-…`, scope `connections:write`), a bot token (`xoxb-…`) with
 * `chat:write`, `app_mentions:read`, `im:history` (+ `channels:history` /
 * `groups:history` to follow up inside threads), and event subscriptions for
 * `app_mention` and `message.im` (+ `message.channels` / `message.groups`).
 * `reactions:write` is optional and only used for the 👀 receipt.
 */

const SLACK_API_BASE = "https://slack.com/api";
const MAX_MESSAGE_LENGTH = 12_000;
const SEEN_EVENTS_MAX = 2_000;
const MAX_PENDING_TURNS_PER_CHAT = 20;
const TURN_TIMEOUT_MS = 600_000;
const HELLO_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_RATE_LIMIT_WAIT_MS = 5_000;
const RECEIPT_REACTION = "eyes";
const WS_OPEN = 1;

export type SlackChannelOptions = {
  botToken?: string;
  appToken?: string;
  mapper?: SlackSessionMapper;
  /** Called after /new so the active session per chat survives restarts. */
  onStateChange?: (state: SlackSessionMapperState) => void;
  /** Override for tests or a corporate proxy that fronts slack.com/api. */
  apiBaseUrl?: string;
  permissionMode?: "default" | "bypassPermissions";
};

type SlackReplyContext = {
  channelId: string;
  /** Thread to reply into; undefined replies at the top of a DM. */
  threadTs?: string;
};

type SlackMessageHandle = { channelId: string; ts: string };

type QueuedSlackTurn = {
  sessionKey: string;
  message: string;
  attachments: never[];
  ctx: SlackReplyContext;
  sourceTs?: string;
  generation: number;
};

class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(`slack ${method} failed: ${code}`);
  }
}

export class SlackChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "slack";

  private readonly mapper: SlackSessionMapper;
  private readonly onStateChange?: (state: SlackSessionMapperState) => void;
  private botToken?: string;
  private appToken?: string;
  private readonly apiBaseUrl: string;
  private permissionMode?: "default" | "bypassPermissions";

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private reportStatus?: ChannelRuntimeStatusReporter;

  private ws: WebSocket | null = null;
  private stopped = true;
  private readonly stopAbort = new AbortController();
  private readonly activeReplies = new Map<string, ImLiveReplyController<SlackMessageHandle>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private lastPongAt = 0;

  private botUserId: string | null = null;
  private botName: string | null = null;
  private reactionsDisabled = false;

  private readonly seen = new Set<string>();
  private readonly engagedThreads = new Set<string>();
  private readonly activeChats = new Set<string>();
  private readonly chatState = new ImChatSessionState<QueuedSlackTurn>({ maxPendingTurns: MAX_PENDING_TURNS_PER_CHAT });
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();

  constructor(options: SlackChannelOptions = {}) {
    this.mapper = options.mapper ?? new SlackSessionMapper();
    this.onStateChange = options.onStateChange;
    this.botToken = options.botToken ?? process.env.SLACK_BOT_TOKEN;
    this.appToken = options.appToken ?? process.env.SLACK_APP_TOKEN;
    this.apiBaseUrl = (options.apiBaseUrl ?? process.env.SLACK_API_BASE_URL ?? SLACK_API_BASE).replace(/\/+$/, "");
    this.permissionMode = options.permissionMode;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;
    this.reportStatus = deps.reportChannelStatus;

    const cfg = deps.config?.adapters?.slack;
    this.botToken = this.botToken || cfg?.token;
    this.appToken = this.appToken || readString(cfg?.extra?.appToken);
    // The loader supplies the current permission override. deps.config is the
    // startup snapshot and must not restore an override removed on hot reload.

    if (!this.botToken || !this.appToken) {
      const missing = !this.botToken ? "bot token (xoxb-…)" : "app-level token (xapp-…)";
      this.logger?.error?.(`slack: ${missing} not configured; set it in Settings → IM or adapters.slack`);
      this.report("failed", `slack: ${missing} not configured`);
      return { stop: async () => undefined };
    }

    try {
      const auth = await this.api<{ user_id?: string; user?: string; team?: string }>("auth.test", {});
      this.botUserId = auth.user_id ?? null;
      this.botName = auth.user ?? null;
      this.logger?.info?.(`slack: authenticated as @${auth.user ?? auth.user_id} in ${auth.team ?? "workspace"}`);
    } catch (error) {
      this.logger?.error?.(`slack: auth.test failed: ${formatError(error)}`);
      this.report("failed", "slack: bot token rejected", formatError(error));
      return { stop: async () => undefined };
    }

    this.stopped = false;
    this.startPing();
    await this.openConnection();

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`slack: stopping (${reason ?? "no reason"})`);
        this.stopped = true;
        this.stopAbort.abort();
        const aborts = this.cancelActiveTurns(reason);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        const ws = this.ws;
        this.ws = null;
        if (ws) {
          try { ws.close(1000, "stopping"); } catch { /* best effort */ }
        }
        await aborts;
      },
    };
  }

  private async cancelActiveTurns(reason?: string): Promise<void> {
    const aborts: Promise<void>[] = [];
    for (const chatId of this.activeChats) {
      const run = this.chatState.activeRun(chatId);
      this.chatState.resetForNewSession(chatId);
      this.elicitation.clear(chatId);
      this.permissions.clear(chatId);
      this.activeReplies.get(chatId)?.cancel();
      if (run && this.gateway) {
        aborts.push(this.gateway.abortTurn({
          sessionKey: run.sessionKey,
          ...(run.runId ? { runId: run.runId } : {}),
          reason: reason ?? "channel stopped",
        }).catch((error: unknown) => {
          this.logger?.warn?.(`slack: abort on stop failed: ${formatError(error)}`);
        }));
      }
    }
    this.activeReplies.clear();
    // A remote gateway may be unreachable; never hold hot reload indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(aborts),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (chatId, text) => {
      const [channelId, threadTs] = chatId.split(":");
      if (!channelId) return false;
      return this.sendText({ channelId, threadTs }, text);
    });
  }

  // ─── Socket Mode connection ────────────────────────────────────────────────

  private async openConnection(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      const opened = await this.api<{ url?: string }>("apps.connections.open", {}, this.appToken);
      if (!opened.url) throw new Error("apps.connections.open returned no url");
      url = opened.url;
    } catch (error) {
      this.logger?.error?.(`slack: apps.connections.open failed: ${formatError(error)}`);
      this.report("failed", "slack: could not open Socket Mode connection", formatError(error));
      this.scheduleReconnect();
      return;
    }
    // stop() may have run while apps.connections.open was in flight; opening a
    // socket now would leave a stray connection that keeps receiving events.
    if (this.stopped) return;

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let greeted = false;
      const helloTimer = setTimeout(() => {
        if (greeted) return;
        this.logger?.warn?.("slack: no hello from Socket Mode, reconnecting");
        ws.terminate();
      }, HELLO_TIMEOUT_MS);
      helloTimer.unref?.();

      ws.on("pong", () => {
        this.lastPongAt = Date.now();
      });
      ws.on("ping", () => {
        this.lastPongAt = Date.now();
      });
      ws.on("message", (raw) => {
        this.lastPongAt = Date.now();
        const frame = parseFrame(raw);
        if (!frame) return;
        if (frame.type === "hello") {
          greeted = true;
          clearTimeout(helloTimer);
          if (this.stopped || this.ws !== ws) {
            try { ws.close(1000, "stopping"); } catch { /* best effort */ }
            resolve();
            return;
          }
          this.reconnectAttempt = 0;
          this.logger?.info?.("slack: Socket Mode connected");
          this.report("connected", `slack: connected as @${this.botName ?? this.botUserId ?? "bot"}`);
          resolve();
          return;
        }
        this.handleFrame(ws, frame);
      });
      ws.on("error", (error) => {
        this.logger?.warn?.(`slack: websocket error: ${formatError(error)}`);
      });
      ws.on("close", (code) => {
        clearTimeout(helloTimer);
        if (!greeted) resolve();
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.stopped) return;
        this.logger?.warn?.(`slack: Socket Mode closed (code=${code}), reconnecting`);
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(immediate = false): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt++;
    const delay = immediate ? 0 : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5));
    if (!immediate && attempt > 0) {
      this.report("starting", `slack: reconnecting in ${Math.round(delay / 1000)}s`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openConnection();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WS_OPEN) return;
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.logger?.warn?.("slack: Socket Mode heartbeat lost, reconnecting");
        ws.terminate();
        return;
      }
      try { ws.ping(); } catch { /* close handler reconnects */ }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private handleFrame(ws: WebSocket, frame: SocketFrame): void {
    // A stopped channel must not ack: unacknowledged envelopes are redelivered
    // to the connection that replaces it (e.g. after a hot reload).
    if (this.stopped) return;
    // Ack first: Slack retries envelopes that are not acknowledged within 3s.
    if (typeof frame.envelope_id === "string") {
      try {
        ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
      } catch (error) {
        this.logger?.warn?.(`slack: ack failed: ${formatError(error)}`);
      }
    }

    if (frame.type === "disconnect") {
      // Slack rotates Socket Mode connections periodically ("refresh_requested").
      this.logger?.info?.(`slack: server requested reconnect (${String(frame.reason ?? "unknown")})`);
      if (this.ws === ws) {
        this.ws = null;
        this.reconnectAttempt = 0;
        this.scheduleReconnect(true);
      }
      try { ws.close(1000, "reconnect"); } catch { /* ignore */ }
      return;
    }

    if (frame.type !== "events_api") return;
    const event = (frame.payload as { event?: SlackEvent } | undefined)?.event;
    if (!event) return;
    void this.handleEvent(event).catch((error: unknown) => {
      this.logger?.error?.(`slack: event handler error: ${formatError(error)}`);
    });
  }

  // ─── Inbound messages ──────────────────────────────────────────────────────

  private async handleEvent(event: SlackEvent): Promise<void> {
    if (this.stopped) return;
    if (event.type !== "message" && event.type !== "app_mention") return;
    if (event.bot_id || event.subtype === "bot_message") return;
    if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast") return;
    if (!event.user || (this.botUserId && event.user === this.botUserId)) return;

    const channelId = event.channel;
    const ts = event.ts;
    if (!channelId || !ts) return;

    const isDm = event.channel_type === "im";
    const threadTs = event.thread_ts ?? (isDm ? undefined : ts);
    const chatId = threadTs ? `${channelId}:${threadTs}` : channelId;
    const mentioned = event.type === "app_mention"
      || Boolean(this.botUserId && event.text?.includes(`<@${this.botUserId}>`));

    // In channels the bot answers @mentions and keeps following threads it is
    // already part of; everything else is channel chatter.
    if (!isDm && !mentioned && !this.engagedThreads.has(chatId)) return;

    // app_mention and message.channels both fire for the same message.
    const dedupeKey = `${channelId}:${ts}`;
    if (this.seen.has(dedupeKey)) return;
    this.remember(dedupeKey);

    const text = normalizeInboundText(event.text ?? "", this.botUserId);
    if (!text) return;

    const ctx: SlackReplyContext = { channelId, threadTs };
    if (!isDm) this.engagedThreads.add(chatId);

    if (this.elicitation.hasPending(chatId) && this.gateway) {
      const confirmation = await this.elicitation.answer(chatId, text, this.gateway);
      if (confirmation) await this.sendText(ctx, confirmation);
      return;
    }

    if (this.permissions.hasPending(chatId) && this.gateway) {
      await this.answerPermission(chatId, ctx, text);
      return;
    }

    // Slack clients treat a leading "/" as one of their own slash commands, so
    // accept "!new", "!status", … as aliases for the shared channel commands.
    const commandText = text.startsWith("!") && resolveCommand(`/${text.slice(1)}`) ? `/${text.slice(1)}` : text;

    const previousSessionKey = this.mapper.resolve({ chatId, text: "" }).sessionKey;
    const mapped = this.mapper.resolve({ chatId, text: commandText });
    if (mapped.command === "new") {
      this.onStateChange?.(this.mapper.snapshot());
      const activeRun = this.chatState.activeRun(chatId);
      this.chatState.resetForNewSession(chatId);
      this.elicitation.clear(chatId);
      this.permissions.clear(chatId);
      await this.gateway?.abortTurn({
        sessionKey: activeRun?.sessionKey ?? previousSessionKey,
        ...(activeRun?.runId ? { runId: activeRun.runId } : {}),
      }).catch((error: unknown) => {
        this.logger?.warn?.(`slack: abort previous session on new failed: ${formatError(error)}`);
      });
      if (!mapped.message) {
        await this.sendText(ctx, ENGLISH_NEW_SESSION_TEXT);
        return;
      }
    }

    if (commandText.startsWith("/") && mapped.command !== "new" && this.gateway) {
      const handled = await executeChannelCommand(commandText, {
        gateway: this.gateway,
        chatId,
        channelKey: "slack",
        reply: (msg) => this.sendText(ctx, msg).then(() => undefined),
        resetSession: () => {
          this.mapper.resolve({ chatId, text: "/new" });
          this.onStateChange?.(this.mapper.snapshot());
        },
        logger: this.logger,
      });
      if (handled) return;
    }

    if (!mapped.message || this.stopped) return;

    const turn: QueuedSlackTurn = {
      sessionKey: mapped.sessionKey,
      message: mapped.message,
      attachments: [],
      ctx,
      sourceTs: ts,
      generation: this.chatState.generation(chatId),
    };

    if (this.activeChats.has(chatId)) {
      this.chatState.queueTurn(chatId, turn);
      this.logger?.info?.(`slack: chat ${chatId} busy, queued message`);
      return;
    }

    this.activeChats.add(chatId);
    try {
      let next: QueuedSlackTurn | undefined = turn;
      while (next && !this.stopped) {
        await this.processTurn(chatId, next);
        next = this.chatState.shiftTurn(chatId);
      }
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private async answerPermission(chatId: string, ctx: SlackReplyContext, text: string): Promise<void> {
    if (!this.gateway) return;
    let answerToken: number | undefined;
    try {
      const answer = await this.permissions.answerWithState(chatId, text, this.gateway);
      answerToken = answer?.answerToken;
      if (!answer?.text) return;
      const confirmationDelivered = await this.sendText(ctx, answer.text);
      if (!confirmationDelivered) {
        this.permissions.releaseAnswer(chatId, answer.answerToken);
        return;
      }
      if (!answer.canAdvance && !answer.retryPrompt) return;
      const nextPrompt = this.permissions.takeNextPrompt(chatId, answer.answerToken);
      if (nextPrompt) {
        const nextPromptRequestId = this.permissions.getPromptRequestId(chatId, answer.answerToken);
        const delivered = await this.sendText(ctx, nextPrompt);
        this.permissions.confirmNextPrompt(chatId, delivered, nextPromptRequestId, answer.answerToken);
      }
    } catch (error) {
      if (answerToken !== undefined) this.permissions.releaseAnswer(chatId, answerToken);
      this.logger?.error?.(`slack: permission answer error: ${formatError(error)}`);
    }
  }

  // ─── Turn processing ───────────────────────────────────────────────────────

  private async processTurn(chatId: string, turn: QueuedSlackTurn): Promise<void> {
    if (!this.gateway) return;
    const isCurrentTurn = () => !this.stopped && this.chatState.isCurrent(chatId, turn.generation);
    if (!isCurrentTurn()) return;

    const receipt = turn.sourceTs ? this.addReaction(turn.ctx.channelId, turn.sourceTs) : Promise.resolve(false);
    const liveReply = new ImLiveReplyController<SlackMessageHandle>({
      transport: this.createLiveTransport(turn.ctx, isCurrentTurn),
      throttleMs: 1_500,
      minEditIntervalMs: 1_000,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      ...ENGLISH_LIVE_REPLY_TEXT,
      onTransportError: (error, phase) => {
        this.logger?.warn?.(`slack: live reply ${phase} failed: ${formatError(error)}`);
      },
    });

    this.activeReplies.set(chatId, liveReply);
    // Track the session before submitTurn yields so stop can abort startup too.
    this.chatState.setActiveRun(chatId, { sessionKey: turn.sessionKey, generation: turn.generation });
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey: turn.sessionKey,
        channelKey: "slack",
        message: turn.message,
        allowPlanModeTools: false,
        timeoutMs: TURN_TIMEOUT_MS,
        ...(this.permissionMode ? { mode: this.permissionMode, basePermissionMode: this.permissionMode } : {}),
      })) {
        if (!isCurrentTurn()) {
          // A run can be created after stop/reset raced submitTurn startup.
          if (event.type === "turn_started") {
            void this.gateway.abortTurn({ sessionKey: turn.sessionKey, runId: event.runId }).catch(() => undefined);
          }
          break;
        }
        if (event.type === "turn_started") {
          this.chatState.setActiveRun(chatId, { sessionKey: turn.sessionKey, runId: event.runId, generation: turn.generation });
        }
        if (event.type === "elicitation_request") {
          const questionText = this.elicitation.capture(chatId, turn.sessionKey, event);
          await liveReply.pauseActivity();
          await this.sendText(turn.ctx, questionText);
          continue;
        }
        if (event.type === "permission_request") {
          const questionText = this.permissions.capture(chatId, turn.sessionKey, event);
          await liveReply.pauseActivity();
          if (questionText) {
            this.permissions.confirmInitialPrompt(chatId, await this.sendText(turn.ctx, questionText), event.requestId);
          }
          continue;
        }
        if (event.type === "error" && event.code === "agent_aborted") {
          await liveReply.markAborted();
          continue;
        }
        if (event.type === "error" && event.code === "turn_timeout") {
          await liveReply.markTimedOut();
          continue;
        }
        await liveReply.handleEvent(event as GatewayEvent);
      }
    } catch (error) {
      if (!isCurrentTurn()) return;
      this.logger?.error?.(`slack: submitTurn error: ${formatError(error)}`);
      await liveReply.handleEvent({
        type: "error",
        code: "channel_submit_failed",
        message: ENGLISH_SUBMIT_FAILED_TEXT,
        recoverable: true,
      } as GatewayEvent);
    } finally {
      if (isCurrentTurn()) {
        this.elicitation.clear(chatId);
        this.permissions.clearAfterTurn(chatId);
      }
      if (isCurrentTurn()) await liveReply.flushFinal();
      else liveReply.cancel();
      if (this.activeReplies.get(chatId) === liveReply) this.activeReplies.delete(chatId);
      const activeRun = this.chatState.activeRun(chatId);
      if (activeRun?.generation === turn.generation) this.chatState.clearActiveRun(chatId);
      if (turn.sourceTs) {
        const sourceTs = turn.sourceTs;
        void receipt.then((added) => (added ? this.removeReaction(turn.ctx.channelId, sourceTs) : undefined));
      }
    }
  }

  private createLiveTransport(ctx: SlackReplyContext, isCurrent: () => boolean): ImLiveReplyTransport<SlackMessageHandle> {
    return {
      maxMessageLength: MAX_MESSAGE_LENGTH,
      preserveCodeFences: true,
      formatText: toSlackMrkdwn,
      send: async (text) => {
        if (!isCurrent()) return false;
        const ts = await this.postMessage(ctx, text);
        return ts ? { channelId: ctx.channelId, ts } : false;
      },
      edit: async (handle, text) => isCurrent() && this.updateMessage(handle, text),
    };
  }

  // ─── Outbound ──────────────────────────────────────────────────────────────

  /** Post plain (already formatted or user-facing) text, split to Slack's size. */
  private async sendText(ctx: SlackReplyContext, text: string): Promise<boolean> {
    if (this.stopAbort.signal.aborted) return false;
    let delivered = true;
    for (const chunk of chunkText(toSlackMrkdwn(text), MAX_MESSAGE_LENGTH)) {
      if (!(await this.postMessage(ctx, chunk))) delivered = false;
    }
    return delivered;
  }

  private async postMessage(ctx: SlackReplyContext, text: string): Promise<string | undefined> {
    try {
      const result = await this.apiWithRetry<{ ts?: string }>("chat.postMessage", {
        channel: ctx.channelId,
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
      });
      return result.ts;
    } catch (error) {
      this.logger?.error?.(`slack: chat.postMessage failed: ${formatError(error)}`);
      return undefined;
    }
  }

  private async updateMessage(handle: SlackMessageHandle, text: string): Promise<boolean> {
    try {
      await this.apiWithRetry("chat.update", { channel: handle.channelId, ts: handle.ts, text });
      return true;
    } catch (error) {
      this.logger?.warn?.(`slack: chat.update failed: ${formatError(error)}`);
      return false;
    }
  }

  private async addReaction(channelId: string, ts: string): Promise<boolean> {
    if (this.reactionsDisabled) return false;
    try {
      await this.api("reactions.add", { channel: channelId, timestamp: ts, name: RECEIPT_REACTION });
      return true;
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "missing_scope") {
        this.reactionsDisabled = true;
        this.logger?.info?.("slack: reactions:write scope missing; skipping 👀 receipts");
      }
      return false;
    }
  }

  private async removeReaction(channelId: string, ts: string): Promise<void> {
    try {
      await this.api("reactions.remove", { channel: channelId, timestamp: ts, name: RECEIPT_REACTION });
    } catch {
      /* cosmetic */
    }
  }

  private async apiWithRetry<T = Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await this.api<T>(method, body);
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "ratelimited" && (error.retryAfterMs ?? 0) <= MAX_RATE_LIMIT_WAIT_MS) {
        await sleep(error.retryAfterMs ?? 1_000);
        return this.api<T>(method, body);
      }
      throw error;
    }
  }

  private async api<T = Record<string, unknown>>(
    method: string,
    body: Record<string, unknown>,
    token: string | undefined = this.botToken,
  ): Promise<T> {
    const res = await fetch(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token ?? ""}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.stopAbort.signal, AbortSignal.timeout(20_000)]),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
    if (res.status === 429 || json.error === "ratelimited") {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new SlackApiError(method, "ratelimited", Number.isFinite(retryAfter) ? retryAfter * 1_000 : undefined);
    }
    if (!res.ok || json.ok !== true) {
      throw new SlackApiError(method, json.error ?? `http_${res.status}`);
    }
    return json;
  }

  private report(state: "starting" | "connected" | "failed", message: string, error?: string): void {
    try {
      this.reportStatus?.("slack", {
        state,
        message,
        ...(this.botName ? { accountId: this.botName } : {}),
        ...(error ? { error } : {}),
      });
    } catch {
      /* status is best effort */
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > SEEN_EVENTS_MAX) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
  }
}

type SocketFrame = {
  type?: string;
  envelope_id?: string;
  payload?: unknown;
  reason?: unknown;
};

type SlackEvent = {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
};

function parseFrame(raw: WebSocket.RawData): SocketFrame | undefined {
  try {
    const text = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : raw.toString();
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SocketFrame) : undefined;
  } catch {
    return undefined;
  }
}

/** Turn Slack's wire format (`<@U1>`, `<url|label>`, `&amp;`) back into plain text. */
export function normalizeInboundText(text: string, botUserId: string | null): string {
  let t = text;
  if (botUserId) t = t.split(`<@${botUserId}>`).join("");
  t = t.replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, name?: string) => `@${name ?? id}`);
  t = t.replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => `#${name || id}`);
  t = t.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1");
  t = t.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url ? url : `${label} (${url})`));
  t = t.replace(/<((?:https?|mailto):[^>]+)>/g, "$1");
  t = t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  // Preserve code indentation and significant whitespace inside the message.
  return t.trim();
}

/**
 * Convert the agent's Markdown into Slack mrkdwn. Code spans and fences are
 * kept verbatim (only HTML-escaped, as Slack requires everywhere).
 */
export function toSlackMrkdwn(content: string): string {
  if (!content) return content;
  const parts = content.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  return parts
    .map((part, index) => {
      const escaped = escapeSlack(part);
      if (index % 2 === 1) return escaped;
      return convertMarkdownSegment(escaped);
    })
    .join("");
}

function convertMarkdownSegment(text: string): string {
  const bold: string[] = [];
  let t = text;
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>");
  t = t.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, title: string) => stash(bold, title));
  t = t.replace(/\*\*(?=\S)([^*\n]+?)\*\*|__(?=\S)([^_\n]+?)__/g, (_m, a?: string, b?: string) => stash(bold, a ?? b ?? ""));
  t = t.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, "$1_$2_");
  t = t.replace(/~~(?=\S)([^~\n]+?)~~/g, "~$1~");
  t = t.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  return t.replace(/\u0000B(\d+)\u0000/g, (_m, i: string) => `*${bold[Number(i)]}*`);
}

function stash(store: string[], value: string): string {
  store.push(value);
  return `\u0000B${store.length - 1}\u0000`;
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function chunkText(content: string, max: number): string[] {
  if (content.length <= max) return [content];
  const out: string[] = [];
  let rest = content;
  while (rest.length > max) {
    let split = rest.lastIndexOf("\n", max);
    if (split < max / 2) split = rest.lastIndexOf(" ", max);
    if (split < max / 2) split = max;
    out.push(rest.slice(0, split));
    rest = rest.slice(split).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
