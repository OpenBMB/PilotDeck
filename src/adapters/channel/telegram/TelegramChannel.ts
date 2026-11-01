import type { CronResultDelivery } from "../../../cron/index.js";
import type { Gateway, GatewayChannelKey, GatewayEvent } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import type { ChannelRuntimeStatusReporter } from "../protocol/ChannelRuntimeStatus.js";
import { executeChannelCommand } from "../protocol/ChannelCommandRegistry.js";
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
import { TelegramSessionMapper, type TelegramSessionMapperState } from "./TelegramSessionMapper.js";

/**
 * Telegram bot channel on the plain Bot API: long polling for updates (no
 * public URL needed) and `editMessageText` for live streamed replies.
 *
 * Private chats answer every message. In groups the bot answers when it is
 * @mentioned, when someone replies to one of its messages, or for commands
 * addressed to it. Group privacy mode must stay on (the default) or the bot
 * should be an admin for it to see mentions.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
/** Telegram caps messages at 4096 chars; leave room for HTML markup. */
const MAX_MESSAGE_LENGTH = 3_800;
const POLL_TIMEOUT_S = 30;
const MAX_PENDING_TURNS_PER_CHAT = 20;
const TURN_TIMEOUT_MS = 600_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const MAX_RATE_LIMIT_WAIT_MS = 5_000;
/** Groups allow ~20 bot messages/minute, so edit less often there. */
const PRIVATE_MIN_EDIT_INTERVAL_MS = 1_000;
const GROUP_MIN_EDIT_INTERVAL_MS = 3_000;

export type TelegramChannelOptions = {
  token?: string;
  /** Unused: the channel always long-polls. Kept for config compatibility. */
  webhookUrl?: string;
  mapper?: TelegramSessionMapper;
  /** Called after /new so the active session per chat survives restarts. */
  onStateChange?: (state: TelegramSessionMapperState) => void;
  /** Override for tests or a self-hosted Bot API server / mirror. */
  apiBaseUrl?: string;
  permissionMode?: "default" | "bypassPermissions";
};

type TelegramReplyContext = {
  chatId: number | string;
  threadId?: number;
  /** Reply to the triggering message in groups so the answer is attributed. */
  replyToMessageId?: number;
  isGroup: boolean;
};

type TelegramMessageHandle = { chatId: number | string; messageId: number };

type QueuedTelegramTurn = {
  sessionKey: string;
  message: string;
  attachments: never[];
  ctx: TelegramReplyContext;
  generation: number;
};

type TelegramUser = { id: number; is_bot?: boolean; username?: string };
type TelegramEntity = { type: string; offset: number; length: number; user?: TelegramUser };
type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  reply_to_message?: { from?: TelegramUser };
};
type TelegramUpdate = { update_id: number; message?: TelegramMessage };

class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfterMs?: number,
  ) {
    super(`telegram ${method} failed (${status}): ${description}`);
  }
}

export class TelegramChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "telegram";

  private readonly mapper: TelegramSessionMapper;
  private readonly onStateChange?: (state: TelegramSessionMapperState) => void;
  private token?: string;
  private readonly apiBaseUrl: string;
  private permissionMode?: "default" | "bypassPermissions";

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private reportStatus?: ChannelRuntimeStatusReporter;

  private stopped = true;
  private readonly stopAbort = new AbortController();
  private readonly activeReplies = new Map<string, ImLiveReplyController<TelegramMessageHandle>>();
  private pollAbort: AbortController | null = null;
  private pollLoop: Promise<void> | null = null;
  private offset = 0;
  private botId: number | null = null;
  private botUsername: string | null = null;

  private readonly activeChats = new Set<string>();
  private readonly chatState = new ImChatSessionState<QueuedTelegramTurn>({ maxPendingTurns: MAX_PENDING_TURNS_PER_CHAT });
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();

  constructor(options: TelegramChannelOptions = {}) {
    this.mapper = options.mapper ?? new TelegramSessionMapper();
    this.onStateChange = options.onStateChange;
    this.token = options.token ?? process.env.TELEGRAM_BOT_TOKEN;
    this.apiBaseUrl = (options.apiBaseUrl ?? process.env.TELEGRAM_API_BASE_URL ?? TELEGRAM_API_BASE).replace(/\/+$/, "");
    this.permissionMode = options.permissionMode;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;
    this.reportStatus = deps.reportChannelStatus;

    const cfg = deps.config?.adapters?.telegram;
    this.token = this.token || cfg?.token;
    // The loader supplies the current permission override. deps.config is the
    // startup snapshot and must not restore an override removed on hot reload.

    if (!this.token) {
      this.logger?.error?.("telegram: bot token not configured; set it in Settings → IM or adapters.telegram.token");
      this.report("failed", "telegram: bot token not configured");
      return { stop: async () => undefined };
    }

    try {
      const me = await this.api<TelegramUser>("getMe", {});
      this.botId = me.id;
      this.botUsername = me.username ?? null;
      // getUpdates refuses to run while a webhook is registered.
      await this.api("deleteWebhook", { drop_pending_updates: false });
      this.logger?.info?.(`telegram: connected as @${me.username ?? me.id}`);
      this.report("connected", `telegram: connected as @${me.username ?? me.id}`);
    } catch (error) {
      this.logger?.error?.(`telegram: start failed: ${formatError(error)}`);
      this.report("failed", "telegram: bot token rejected or Telegram unreachable", formatError(error));
      return { stop: async () => undefined };
    }

    this.stopped = false;
    this.pollLoop = this.runPollLoop();

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`telegram: stopping (${reason ?? "no reason"})`);
        this.stopped = true;
        this.stopAbort.abort();
        const aborts = this.cancelActiveTurns(reason);
        this.pollAbort?.abort();
        await this.pollLoop?.catch(() => undefined);
        this.pollLoop = null;
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
          this.logger?.warn?.(`telegram: abort on stop failed: ${formatError(error)}`);
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
      const [id, thread] = chatId.split(":");
      if (!id) return false;
      const threadId = thread ? Number(thread) : undefined;
      return this.sendText({ chatId: id, isGroup: id.startsWith("-"), ...(threadId ? { threadId } : {}) }, text);
    });
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  private async runPollLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      this.pollAbort = new AbortController();
      try {
        const updates = await this.api<TelegramUpdate[]>(
          "getUpdates",
          { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message"] },
          { signal: this.pollAbort.signal, timeoutMs: (POLL_TIMEOUT_S + 15) * 1_000 },
        );
        if (failures > 0) {
          this.report("connected", `telegram: connected as @${this.botUsername ?? this.botId}`);
        }
        failures = 0;
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          if (update.message) {
            void this.handleMessage(update.message).catch((error: unknown) => {
              this.logger?.error?.(`telegram: message handler error: ${formatError(error)}`);
            });
          }
        }
      } catch (error) {
        if (this.stopped) break;
        failures += 1;
        const conflict = error instanceof TelegramApiError && error.status === 409;
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5));
        this.logger?.warn?.(
          conflict
            ? "telegram: another process is polling this bot token (409); retrying"
            : `telegram: getUpdates failed: ${formatError(error)}; retrying in ${Math.round(delay / 1000)}s`,
        );
        if (failures === 3) {
          this.report("failed", conflict ? "telegram: token is in use by another bot process" : "telegram: cannot reach Telegram", formatError(error));
        }
        await new Promise<void>((resolve) => {
          if (this.stopped) return resolve();
          const onStop = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            this.stopAbort.signal.removeEventListener("abort", onStop);
            resolve();
          }, delay);
          this.stopAbort.signal.addEventListener("abort", onStop, { once: true });
        });
      }
    }
  }

  // ─── Inbound ───────────────────────────────────────────────────────────────

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    if (this.stopped) return;
    if (!msg.from || msg.from.is_bot) return;
    const rawText = msg.text ?? msg.caption ?? "";
    if (!rawText.trim()) return;

    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    if (msg.chat.type === "channel") return;
    const entities = msg.entities ?? msg.caption_entities ?? [];
    if (isGroup && !this.isAddressedToBot(msg, rawText, entities)) return;

    const text = this.stripBotAddress(rawText);
    if (!text) return;

    const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
    const chatId = threadId ? `${msg.chat.id}:${threadId}` : String(msg.chat.id);
    const ctx: TelegramReplyContext = {
      chatId: msg.chat.id,
      isGroup,
      ...(threadId ? { threadId } : {}),
      ...(isGroup ? { replyToMessageId: msg.message_id } : {}),
    };

    if (this.elicitation.hasPending(chatId) && this.gateway) {
      const confirmation = await this.elicitation.answer(chatId, text, this.gateway);
      if (confirmation) await this.sendText(ctx, confirmation);
      return;
    }

    if (this.permissions.hasPending(chatId) && this.gateway) {
      await this.answerPermission(chatId, ctx, text);
      return;
    }

    const previousSessionKey = this.mapper.resolve({ chatId, text: "" }).sessionKey;
    const mapped = this.mapper.resolve({ chatId, text });
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
        this.logger?.warn?.(`telegram: abort previous session on /new failed: ${formatError(error)}`);
      });
      if (!mapped.message) {
        await this.sendText(ctx, ENGLISH_NEW_SESSION_TEXT);
        return;
      }
    }

    if (text.startsWith("/") && mapped.command !== "new" && this.gateway) {
      if (text === "/start" || text.startsWith("/start ")) {
        await this.sendText(ctx, "Hi! Send me a message and I'll get to work. Use /new to start a fresh session.");
        return;
      }
      const handled = await executeChannelCommand(text, {
        gateway: this.gateway,
        chatId,
        channelKey: "telegram",
        reply: (reply) => this.sendText(ctx, reply).then(() => undefined),
        resetSession: () => {
          this.mapper.resolve({ chatId, text: "/new" });
          this.onStateChange?.(this.mapper.snapshot());
        },
        logger: this.logger,
      });
      if (handled) return;
    }

    if (!mapped.message || this.stopped) return;

    const turn: QueuedTelegramTurn = {
      sessionKey: mapped.sessionKey,
      message: mapped.message,
      attachments: [],
      ctx,
      generation: this.chatState.generation(chatId),
    };

    if (this.activeChats.has(chatId)) {
      this.chatState.queueTurn(chatId, turn);
      this.logger?.info?.(`telegram: chat ${chatId} busy, queued message`);
      return;
    }

    this.activeChats.add(chatId);
    try {
      let next: QueuedTelegramTurn | undefined = turn;
      while (next && !this.stopped) {
        await this.processTurn(chatId, next);
        next = this.chatState.shiftTurn(chatId);
      }
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private isAddressedToBot(msg: TelegramMessage, text: string, entities: TelegramEntity[]): boolean {
    if (this.botId && msg.reply_to_message?.from?.id === this.botId) return true;
    const username = this.botUsername?.toLowerCase();
    for (const entity of entities) {
      const value = text.slice(entity.offset, entity.offset + entity.length);
      if (entity.type === "mention" && username && value.toLowerCase() === `@${username}`) return true;
      if (entity.type === "text_mention" && this.botId && entity.user?.id === this.botId) return true;
      if (entity.type === "bot_command" && entity.offset === 0) {
        const at = value.indexOf("@");
        if (at === -1 || (username && value.slice(at + 1).toLowerCase() === username)) return true;
      }
    }
    return false;
  }

  /** Drop "@botname" mentions and "/cmd@botname" suffixes. */
  private stripBotAddress(text: string): string {
    if (!this.botUsername) return text.trim();
    const escaped = this.botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text
      .replace(new RegExp(`^(/[A-Za-z0-9_-]+)@${escaped}\\b`, "i"), "$1")
      .replace(new RegExp(`@${escaped}\\b`, "gi"), "")
      .trim();
  }

  private async answerPermission(chatId: string, ctx: TelegramReplyContext, text: string): Promise<void> {
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
      this.logger?.error?.(`telegram: permission answer error: ${formatError(error)}`);
    }
  }

  // ─── Turn processing ───────────────────────────────────────────────────────

  private async processTurn(chatId: string, turn: QueuedTelegramTurn): Promise<void> {
    if (!this.gateway) return;
    const isCurrentTurn = () => !this.stopped && this.chatState.isCurrent(chatId, turn.generation);
    if (!isCurrentTurn()) return;

    void this.api("sendChatAction", {
      chat_id: turn.ctx.chatId,
      action: "typing",
      ...(turn.ctx.threadId ? { message_thread_id: turn.ctx.threadId } : {}),
    }).catch(() => undefined);

    const liveReply = new ImLiveReplyController<TelegramMessageHandle>({
      transport: this.createLiveTransport(turn.ctx, isCurrentTurn),
      throttleMs: 1_500,
      minEditIntervalMs: turn.ctx.isGroup ? GROUP_MIN_EDIT_INTERVAL_MS : PRIVATE_MIN_EDIT_INTERVAL_MS,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      ...ENGLISH_LIVE_REPLY_TEXT,
      onTransportError: (error, phase) => {
        this.logger?.warn?.(`telegram: live reply ${phase} failed: ${formatError(error)}`);
      },
    });

    this.activeReplies.set(chatId, liveReply);
    // Track the session before submitTurn yields so stop can abort startup too.
    this.chatState.setActiveRun(chatId, { sessionKey: turn.sessionKey, generation: turn.generation });
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey: turn.sessionKey,
        channelKey: "telegram",
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
        await liveReply.handleEvent(event);
      }
    } catch (error) {
      if (!isCurrentTurn()) return;
      this.logger?.error?.(`telegram: submitTurn error: ${formatError(error)}`);
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
    }
  }

  private createLiveTransport(ctx: TelegramReplyContext, isCurrent: () => boolean): ImLiveReplyTransport<TelegramMessageHandle> {
    let replyAttached = false;
    return {
      maxMessageLength: MAX_MESSAGE_LENGTH,
      preserveCodeFences: true,
      send: async (text) => {
        if (!isCurrent()) return false;
        // Only the first message of a reply quotes the user's message.
        const messageId = await this.sendMessage(replyAttached ? { ...ctx, replyToMessageId: undefined } : ctx, text);
        if (messageId === undefined) return false;
        replyAttached = true;
        return { chatId: ctx.chatId, messageId };
      },
      edit: async (handle, text) => isCurrent() && this.editMessage(handle, text),
    };
  }

  // ─── Outbound ──────────────────────────────────────────────────────────────

  private async sendText(ctx: TelegramReplyContext, text: string): Promise<boolean> {
    if (this.stopAbort.signal.aborted) return false;
    let delivered = true;
    for (const chunk of chunkText(text, MAX_MESSAGE_LENGTH)) {
      if ((await this.sendMessage(ctx, chunk)) === undefined) delivered = false;
    }
    return delivered;
  }

  private async sendMessage(ctx: TelegramReplyContext, text: string): Promise<number | undefined> {
    const base = {
      chat_id: ctx.chatId,
      link_preview_options: { is_disabled: true },
      ...(ctx.threadId ? { message_thread_id: ctx.threadId } : {}),
      ...(ctx.replyToMessageId ? { reply_parameters: { message_id: ctx.replyToMessageId, allow_sending_without_reply: true } } : {}),
    };
    try {
      const sent = await this.apiWithRetry<{ message_id: number }>("sendMessage", { ...base, text: toTelegramHtml(text), parse_mode: "HTML" })
        .catch(async (error: unknown) => {
          if (!isEntityParseError(error)) throw error;
          return this.apiWithRetry<{ message_id: number }>("sendMessage", { ...base, text });
        });
      return sent.message_id;
    } catch (error) {
      this.logger?.error?.(`telegram: sendMessage failed: ${formatError(error)}`);
      return undefined;
    }
  }

  private async editMessage(handle: TelegramMessageHandle, text: string): Promise<boolean> {
    const base = {
      chat_id: handle.chatId,
      message_id: handle.messageId,
      link_preview_options: { is_disabled: true },
    };
    try {
      await this.apiWithRetry("editMessageText", { ...base, text: toTelegramHtml(text), parse_mode: "HTML" })
        .catch(async (error: unknown) => {
          if (!isEntityParseError(error)) throw error;
          return this.apiWithRetry("editMessageText", { ...base, text });
        });
      return true;
    } catch (error) {
      if (error instanceof TelegramApiError && /message is not modified/i.test(error.description)) return true;
      this.logger?.warn?.(`telegram: editMessageText failed: ${formatError(error)}`);
      return false;
    }
  }

  private async apiWithRetry<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await this.api<T>(method, body);
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 429 && (error.retryAfterMs ?? 0) <= MAX_RATE_LIMIT_WAIT_MS) {
        await sleep(error.retryAfterMs ?? 1_000);
        return this.api<T>(method, body);
      }
      throw error;
    }
  }

  private async api<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    const signal = AbortSignal.any([this.stopAbort.signal, timeout, ...(options.signal ? [options.signal] : [])]);
    const res = await fetch(`${this.apiBaseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!res.ok || json.ok !== true) {
      const retryAfter = json.parameters?.retry_after;
      throw new TelegramApiError(method, res.status, json.description ?? `HTTP ${res.status}`, retryAfter ? retryAfter * 1_000 : undefined);
    }
    return json.result as T;
  }

  private report(state: "connected" | "failed", message: string, error?: string): void {
    try {
      this.reportStatus?.("telegram", {
        state,
        message,
        ...(this.botUsername ? { accountId: `@${this.botUsername}` } : {}),
        ...(error ? { error } : {}),
      });
    } catch {
      /* status is best effort */
    }
  }
}

function isEntityParseError(error: unknown): boolean {
  return error instanceof TelegramApiError && error.status === 400 && /can't parse entities|unsupported start tag|can't find end/i.test(error.description);
}

/**
 * Render the agent's Markdown as Telegram HTML (the most forgiving parse
 * mode). Anything the converter gets wrong falls back to plain text.
 */
export function toTelegramHtml(content: string): string {
  if (!content) return content;
  const parts = content.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        if (part.startsWith("```")) {
          const body = part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
          return `<pre>${escapeHtml(body)}</pre>`;
        }
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      let t = escapeHtml(part);
      t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`);
      t = t.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, "<b>$1</b>");
      t = t.replace(/\*\*(?=\S)([^*\n]+?)\*\*|__(?=\S)([^_\n]+?)__/g, (_m, a?: string, b?: string) => `<b>${a ?? b ?? ""}</b>`);
      t = t.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, "$1<i>$2</i>");
      t = t.replace(/~~(?=\S)([^~\n]+?)~~/g, "<s>$1</s>");
      t = t.replace(/^(\s*)[-*]\s+/gm, "$1• ");
      return t;
    })
    .join("");
}

function escapeHtml(text: string): string {
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

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
