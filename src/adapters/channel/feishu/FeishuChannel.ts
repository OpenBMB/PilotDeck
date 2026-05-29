import { createDecipheriv, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Gateway } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { FeishuSessionMapper } from "./FeishuSessionMapper.js";
import { renderFeishuEvent } from "./feishu-render.js";

let Lark: any = null;
let larkLoadAttempted = false;
async function loadLarkSdk(): Promise<any> {
  if (Lark || larkLoadAttempted) return Lark;
  larkLoadAttempted = true;
  try {
    const mod = await import("@larksuiteoapi/node-sdk");
    Lark = (mod as { default?: unknown }).default ?? mod;
  } catch {
    Lark = null;
  }
  return Lark;
}

const TENANT_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const SEND_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";
const MESSAGE_REACTIONS_URL = (messageId: string) =>
  `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`;
const BOT_INFO_URL = "https://open.feishu.cn/open-apis/bot/v3/info";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const SEEN_EVENTS_MAX = 2000;

// Reaction constants
const FEISHU_REACTION_IN_PROGRESS = "Typing";  // 处理中状态
const FEISHU_REACTION_FAILURE = "CrossMark";    // 处理失败状态
const FEISHU_PROCESSING_REACTION_CACHE_SIZE = 1024;

export type FeishuOutboundMessage = {
  chatId: string;
  text: string;
};

export type FeishuConnectionMode = "stream" | "webhook";

export type FeishuChannelOptions = {
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verifyToken?: string;
  /**
   * "stream" (default): outbound WebSocket via @larksuiteoapi/node-sdk — no
   * public URL needed, identical to weixin-ilink long-polling.
   * "webhook": passive mode where Lark POSTs to /feishu/webhook (requires
   * a public tunnel).
   */
  connectionMode?: FeishuConnectionMode;
  /** "feishu" (open.feishu.cn) or "lark" (open.larksuite.com). */
  domainName?: "feishu" | "lark";
  mapper?: FeishuSessionMapper;
  /**
   * Optional override for outbound delivery (used in tests). When omitted the
   * channel calls Lark Open API directly.
   */
  send?: (message: FeishuOutboundMessage) => Promise<void>;
};

type ParsedEvent =
  | { kind: "url_verification"; challenge: string }
  | { kind: "message"; eventId: string; chatId: string; text: string; messageId?: string }
  | { kind: "ignore" };

export class FeishuChannel implements ChannelAdapter {
  readonly channelKey = "feishu";

  private readonly mapper: FeishuSessionMapper;
  private readonly explicitSend?: (message: FeishuOutboundMessage) => Promise<void>;

  private appId: string;
  private appSecret: string;
  private encryptKey?: string;
  private verifyToken?: string;
  private connectionMode: FeishuConnectionMode;
  private domainName: "feishu" | "lark";

  private gateway?: Gateway;
  private logger?: ChannelLogger;

  private tokenCache?: { value: string; expiresAt: number };
  private tokenInflight?: Promise<string>;
  private readonly seenEvents = new Set<string>();
  private readonly activeChats = new Set<string>();

  // Bot 身份信息（用于 mention 检查）
  private botOpenId: string = "";
  private botFetched = false;

  // Reaction 相关状态
  private readonly _sentMessageIds = new Map<string, string>(); // message_id → chat_id
  private readonly _pendingProcessingReactions = new Map<string, string>(); // message_id → reaction_id

  private wsClient: any = null;

  constructor(options: FeishuChannelOptions = {}) {
    this.mapper = options.mapper ?? new FeishuSessionMapper();
    this.explicitSend = options.send;
    this.appId = options.appId ?? "";
    this.appSecret = options.appSecret ?? "";
    this.encryptKey = options.encryptKey;
    this.verifyToken = options.verifyToken;
    this.connectionMode = options.connectionMode ?? "stream";
    this.domainName = options.domainName ?? "feishu";
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    const cfg = deps.config?.adapters?.feishu;
    if (cfg) {
      this.appId = this.appId || cfg.appId || "";
      this.appSecret = this.appSecret || cfg.appSecret || "";
      this.encryptKey = this.encryptKey ?? cfg.encryptKey;
      this.verifyToken = this.verifyToken ?? cfg.verifyToken;
    }

    if (!this.explicitSend && (!this.appId || !this.appSecret)) {
      this.logger?.warn?.(
        "feishu: appId/appSecret not configured; outbound replies will not be sent. " +
          "Configure adapters.feishu.appId/appSecret in pilotdeck.yaml.",
      );
      return { stop: async () => undefined };
    }

    if (this.connectionMode === "stream") {
      const ok = await this.startStreamMode();
      if (!ok) {
        this.logger?.warn?.(
          "feishu: stream mode failed to start; falling back to webhook-only " +
            "(set adapters.feishu.connectionMode: webhook in pilotdeck.yaml to silence this).",
        );
      }
    } else {
      this.logger?.info?.(
        `feishu: ready in webhook mode (appId=${maskAppId(this.appId)}); waiting for POST /feishu/webhook`,
      );
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`feishu: stopping (${reason ?? "no reason"})`);
        if (this.wsClient && typeof this.wsClient.stop === "function") {
          try { this.wsClient.stop(); } catch { /* best effort */ }
        }
        this.wsClient = null;
      },
    };
  }

  private async startStreamMode(): Promise<boolean> {
    const sdk = await loadLarkSdk();
    if (!sdk) {
      this.logger?.error?.(
        "feishu: @larksuiteoapi/node-sdk failed to load; run `npm install @larksuiteoapi/node-sdk` " +
          "or set adapters.feishu.connectionMode: webhook",
      );
      return false;
    }

    try {
      const dispatcher = new sdk.EventDispatcher({}).register({
        "im.message.receive_v1": (data: unknown) => {
          this.logger?.info?.("feishu: ★ im.message.receive_v1 fired");
          void this.handleStreamEvent(data).catch((e: unknown) => {
            this.logger?.error?.(`feishu: stream event handler error: ${e}`);
          });
        },
      });

      const domain =
        this.domainName === "lark"
          ? sdk.Domain?.Lark ?? "https://open.larksuite.com"
          : sdk.Domain?.Feishu ?? "https://open.feishu.cn";

      this.wsClient = new sdk.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain,
        loggerLevel: sdk.LoggerLevel?.info ?? 2,
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
      this.logger?.info?.(`feishu: stream mode connected (appId=${maskAppId(this.appId)})`);
      
      // 获取机器人信息（用于 mention 检查）
      await this._fetchBotInfo();
      
      return true;
    } catch (e) {
      this.logger?.error?.(`feishu: stream mode start failed: ${e}`);
      return false;
    }
  }

  private async handleStreamEvent(data: unknown): Promise<void> {
    const raw = data as Record<string, unknown>;
    const message = (raw.message ?? (raw as { event?: { message?: unknown } }).event?.message) as
      | { chat_id?: string; content?: string; message_type?: string; message_id?: string; chat_type?: string; mentions?: Array<{ id?: { open_id?: string; union_id?: string; user_id?: string }; key?: string; name?: string }> }
      | undefined;
    if (!message) return;
    if (message.message_type !== "text") return;

    const chatId = message.chat_id;
    if (!chatId || message.content === undefined) return;

    // 群聊消息需要检查是否 mention 了机器人
    const chatType = message.chat_type ?? "p2p";
    if (chatType === "group") {
      // 检查消息中是否包含 mention pilotdeck 机器人
      const mentions = message.mentions ?? [];
      const hasBotMention = this._isMentioningBot(mentions);

      if (!hasBotMention) {
        this.logger?.debug?.(`feishu: skipping group message without bot mention in chat ${chatId}`);
        return;
      }
    }

    const text = extractTextContent(message.content);
    const eventId = message.message_id ?? `stream:${chatId}:${Date.now()}`;
    const messageId = message.message_id;

    if (this.seenEvents.has(eventId)) return;
    this.rememberEvent(eventId);

    await this.processInboundMessage(chatId, text, messageId);
  }

  async handleWebhook(request: IncomingMessage, response: ServerResponse, body: string): Promise<boolean> {
    if (!this.gateway) {
      respondJson(response, 503, { error: "feishu_not_started" });
      return true;
    }

    const parsed = this.parseInbound(body);

    if (parsed.kind === "url_verification") {
      respondJson(response, 200, { challenge: parsed.challenge });
      return true;
    }

    if (parsed.kind === "ignore") {
      respondJson(response, 200, { ok: true });
      return true;
    }

    if (this.seenEvents.has(parsed.eventId)) {
      respondJson(response, 200, { ok: true, deduped: true });
      return true;
    }
    this.rememberEvent(parsed.eventId);

    respondJson(response, 200, { ok: true });
    void this.processInboundMessage(parsed.chatId, parsed.text, parsed.messageId).catch((e) => {
      this.logger?.error?.(`feishu: processInboundMessage error: ${e}`);
    });
    return true;
  }

  private async processInboundMessage(chatId: string, text: string, messageId?: string): Promise<void> {
    if (!this.gateway) return;

    const mapped = this.mapper.resolve({ chatId, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.send({ chatId, text: "已创建新会话。" });
      return;
    }
    if (!mapped.message) return;

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`feishu: chat ${chatId} already active, skipping`);
      return;
    }

    this.activeChats.add(chatId);
    
    // 添加 Typing reaction 表示正在处理
    let processingReactionId: string | undefined;
    if (messageId) {
      processingReactionId = await this._addReaction(messageId, FEISHU_REACTION_IN_PROGRESS) ?? undefined;
      if (processingReactionId) {
        this._pendingProcessingReactions.set(messageId, processingReactionId);
      }
    }

    let success = false;
    try {
      let buffer = "";
      try {
        for await (const event of this.gateway.submitTurn({
          sessionKey: mapped.sessionKey,
          channelKey: "feishu",
          message: mapped.message,
        })) {
          buffer += renderFeishuEvent(event) ?? "";
        }
      } catch (e) {
        this.logger?.error?.(`feishu: submitTurn error: ${e}`);
        buffer = "处理消息时发生错误，请重试。";
      }

      const reply = buffer.trim();
      if (reply) {
        await this.send({ chatId, text: reply });
        success = true;
      }
    } finally {
      // 移除 Typing reaction
      if (messageId && processingReactionId) {
        await this._removeReaction(messageId, processingReactionId);
        this._pendingProcessingReactions.delete(messageId);
      }

      // 如果处理失败，添加 CrossMark reaction
      if (!success && messageId) {
        await this._addReaction(messageId, FEISHU_REACTION_FAILURE);
      }

      this.activeChats.delete(chatId);
    }
  }

  private async send(message: FeishuOutboundMessage): Promise<void> {
    if (this.explicitSend) {
      await this.explicitSend(message);
      return;
    }
    if (!this.appId || !this.appSecret) {
      this.logger?.warn?.("feishu: cannot send — appId/appSecret missing");
      return;
    }

    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(SEND_MESSAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: message.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: message.text }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.error?.(`feishu: send failed code=${json.code} msg=${json.msg}`);
      }
    } catch (e) {
      this.logger?.error?.(`feishu: send threw: ${e}`);
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - TOKEN_REFRESH_BUFFER_MS > now) {
      return this.tokenCache.value;
    }
    if (this.tokenInflight) return this.tokenInflight;

    this.tokenInflight = (async () => {
      try {
        const res = await fetch(TENANT_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        });
        const json = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
        if (json.code !== 0 || !json.tenant_access_token) {
          throw new Error(`tenant_access_token failed: code=${json.code} msg=${json.msg}`);
        }
        const expireSec = typeof json.expire === "number" ? json.expire : 7200;
        this.tokenCache = {
          value: json.tenant_access_token,
          expiresAt: Date.now() + expireSec * 1000,
        };
        return this.tokenCache.value;
      } finally {
        this.tokenInflight = undefined;
      }
    })();

    return this.tokenInflight;
  }

  private parseInbound(body: string): ParsedEvent {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return { kind: "ignore" };
    }

    if (typeof raw.encrypt === "string" && this.encryptKey) {
      try {
        const decrypted = decryptFeishuPayload(raw.encrypt, this.encryptKey);
        raw = JSON.parse(decrypted) as Record<string, unknown>;
      } catch (e) {
        this.logger?.error?.(`feishu: decrypt failed: ${e}`);
        return { kind: "ignore" };
      }
    }

    if (raw.type === "url_verification" && typeof raw.challenge === "string") {
      if (this.verifyToken && raw.token !== this.verifyToken) {
        this.logger?.warn?.("feishu: url_verification token mismatch");
      }
      return { kind: "url_verification", challenge: raw.challenge };
    }

    if (this.verifyToken) {
      const token = (raw.token as string | undefined) ?? ((raw.header as { token?: string } | undefined)?.token);
      if (token && token !== this.verifyToken) {
        this.logger?.warn?.("feishu: verifyToken mismatch — ignoring event");
        return { kind: "ignore" };
      }
    }

    const direct = parseDirectShape(raw);
    if (direct) return direct;

    const v2 = parseV2Event(raw);
    if (v2) return v2;

    const v1 = parseV1Event(raw);
    if (v1) return v1;

    return { kind: "ignore" };
  }

  private rememberEvent(eventId: string): void {
    this.seenEvents.add(eventId);
    if (this.seenEvents.size > SEEN_EVENTS_MAX) {
      const first = this.seenEvents.values().next().value;
      if (first) this.seenEvents.delete(first);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Bot identity and mention helpers
  // ────────────────────────────────────────────────────────────────

  /**
   * 获取机器人信息（open_id），用于 mention 检查
   */
  private async _fetchBotInfo(): Promise<void> {
    if (this.botFetched || !this.appId || !this.appSecret) return;
    this.botFetched = true;

    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(BOT_INFO_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        msg?: string;
        bot?: { open_id?: string; app_name?: string };
      };
      if (json.code === 0 && json.bot?.open_id) {
        this.botOpenId = json.bot.open_id;
        this.logger?.info?.(`feishu: bot open_id = ${this.botOpenId}`);
      } else {
        this.logger?.warn?.(`feishu: failed to fetch bot info: code=${json.code} msg=${json.msg}`);
      }
    } catch (e) {
      this.logger?.warn?.(`feishu: fetchBotInfo threw: ${e}`);
    }
  }

  /**
   * 检查 mentions 中是否包含本机器人
   * 优先匹配 open_id，其次匹配 @_all
   */
  private _isMentioningBot(mentions: Array<{ id?: { open_id?: string; union_id?: string; user_id?: string }; key?: string; name?: string }>): boolean {
    for (const mention of mentions) {
      // 优先匹配 open_id
      if (mention.id?.open_id && this.botOpenId) {
        if (mention.id.open_id === this.botOpenId) {
          return true;
        }
        continue; // open_id 不匹配，跳过
      }
      // 备选：匹配 @_all（@所有人）
      if (mention.key === "@_all") {
        return true;
      }
    }
    return false;
  }

  // ────────────────────────────────────────────────────────────────
  // Reaction helpers (借鉴 hermes-agent)
  // ────────────────────────────────────────────────────────────────

  private async _addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(MESSAGE_REACTIONS_URL(messageId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        msg?: string;
        data?: { reaction_id?: string };
      };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        this.logger?.warn?.(
          `feishu: addReaction(${emojiType}) failed on ${messageId}: code=${json.code} msg=${json.msg}`,
        );
        return null;
      }
      return json.data?.reaction_id ?? null;
    } catch (e) {
      this.logger?.warn?.(`feishu: addReaction(${emojiType}) threw on ${messageId}: ${e}`);
      return null;
    }
  }

  private async _removeReaction(messageId: string, reactionId: string): Promise<boolean> {
    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(`${MESSAGE_REACTIONS_URL(messageId)}/${reactionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        this.logger?.warn?.(
          `feishu: removeReaction failed on ${messageId}/${reactionId}: code=${json.code} msg=${json.msg}`,
        );
        return false;
      }
      return true;
    } catch (e) {
      this.logger?.warn?.(`feishu: removeReaction threw on ${messageId}/${reactionId}: ${e}`);
      return false;
    }
  }

  /**
   * 处理收到的 reaction 事件（用户对消息添加/删除表情回应）。
   * 过滤 bot 自身的 reaction，记录用户操作。
   */
  private async _onReactionEvent(
    action: "created" | "deleted",
    data: Record<string, unknown>,
  ): Promise<void> {
    const messageId = data.message_id as string | undefined;
    const emojiType = (data as { emoji_type?: string; reaction_type?: { emoji_type?: string } }).emoji_type
      ?? (data as { reaction_type?: { emoji_type?: string } }).reaction_type?.emoji_type;
    const operatorType = data.operator_type as string | undefined;

    if (!messageId) {
      this.logger?.warn?.("feishu: reaction event missing message_id");
      return;
    }

    // 过滤 bot/app 自身的 reaction（避免循环）
    if (operatorType === "app" || operatorType === "bot") {
      return;
    }

    this.logger?.info?.(
      `feishu: reaction ${action} on ${messageId}: emoji=${emojiType} by ${operatorType ?? "unknown"}`,
    );

    // TODO: 未来可以将用户 reaction 路由为合成消息事件
    // "reaction:added:THUMBSUP" → 进入 agent 处理流程
  }
}

function parseDirectShape(raw: Record<string, unknown>): ParsedEvent | undefined {
  if (typeof raw.chatId === "string" && typeof raw.text === "string") {
    return {
      kind: "message",
      eventId: typeof raw.eventId === "string" ? raw.eventId : `direct:${raw.chatId}:${Date.now()}`,
      chatId: raw.chatId,
      text: raw.text,
    };
  }
  return undefined;
}

function parseV2Event(raw: Record<string, unknown>): ParsedEvent | undefined {
  const header = raw.header as { event_id?: string; event_type?: string } | undefined;
  const event = raw.event as
    | { message?: { chat_id?: string; content?: string; message_type?: string; message_id?: string } }
    | undefined;

  if (!header?.event_id || !event?.message) return undefined;
  if (header.event_type !== "im.message.receive_v1") return { kind: "ignore" };
  if (event.message.message_type !== "text") return { kind: "ignore" };

  const chatId = event.message.chat_id;
  const content = event.message.content;
  const messageId = event.message.message_id;
  if (!chatId || content === undefined) return undefined;

  const text = extractTextContent(content);
  return { kind: "message", eventId: header.event_id, chatId, text, messageId };
}

function parseV1Event(raw: Record<string, unknown>): ParsedEvent | undefined {
  const event = raw.event as
    | { chat_id?: string; text?: string; type?: string; msg_type?: string; uuid?: string }
    | undefined;
  if (!event?.chat_id || event.text === undefined) return undefined;
  const eventId = (raw.uuid as string | undefined) ?? event.uuid ?? `v1:${event.chat_id}:${Date.now()}`;
  return { kind: "message", eventId, chatId: event.chat_id, text: event.text };
}

function extractTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? "";
  } catch {
    return content;
  }
}

function decryptFeishuPayload(encrypted: string, key: string): string {
  const aesKey = createHash("sha256").update(key, "utf8").digest();
  const buf = Buffer.from(encrypted, "base64");
  const iv = buf.subarray(0, 16);
  const cipherText = buf.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(true);
  const decoded = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return decoded.toString("utf8");
}

function maskAppId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
