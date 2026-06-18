import { createDecipheriv, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Gateway } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { executeChannelCommand, resolveCommand } from "../protocol/ChannelCommandRegistry.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import {
  ImLiveReplyController,
  type ImLiveReplyControllerOptions,
  type ImLiveReplyTransport,
} from "../protocol/ImLiveReplyController.js";
import { FeishuSessionMapper } from "./FeishuSessionMapper.js";

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
const REACTION_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
const UPDATE_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
const PROCESSING_EMOJI = "OnIt";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const SEEN_EVENTS_MAX = 2000;
const MAX_TEXT_MESSAGE_LENGTH = 4000;
const DEFAULT_LIVE_REPLY_CURSOR = " ▉";

export type FeishuOutboundMessage = {
  chatId: string;
  text: string;
};

export type FeishuLiveMessageHandle = {
  messageId: string;
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
  liveReplyOptions?: Omit<
    ImLiveReplyControllerOptions<FeishuLiveMessageHandle>,
    "transport" | "onTransportError"
  >;
};

type ParsedEvent =
  | { kind: "url_verification"; challenge: string }
  | { kind: "message"; eventId: string; chatId: string; text: string; messageId?: string }
  | { kind: "ignore" };

export class FeishuChannel implements ChannelAdapter {
  readonly channelKey = "feishu";

  private readonly mapper: FeishuSessionMapper;
  private readonly explicitSend?: (message: FeishuOutboundMessage) => Promise<void>;
  private readonly liveReplyOptions?: FeishuChannelOptions["liveReplyOptions"];

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
  private readonly elicitation = new ImElicitationHelper();

  private wsClient: any = null;

  constructor(options: FeishuChannelOptions = {}) {
    this.mapper = options.mapper ?? new FeishuSessionMapper();
    this.explicitSend = options.send;
    this.liveReplyOptions = options.liveReplyOptions;
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
      return true;
    } catch (e) {
      this.logger?.error?.(`feishu: stream mode start failed: ${e}`);
      return false;
    }
  }

  private async handleStreamEvent(data: unknown): Promise<void> {
    const raw = data as Record<string, unknown>;
    const message = (raw.message ?? (raw as { event?: { message?: unknown } }).event?.message) as
      | { chat_id?: string; content?: string; message_type?: string; message_id?: string }
      | undefined;
    if (!message) return;
    if (message.message_type !== "text") return;

    const chatId = message.chat_id;
    if (!chatId || message.content === undefined) return;

    const text = extractTextContent(message.content);
    const messageId = message.message_id;
    const eventId = messageId ?? `stream:${chatId}:${Date.now()}`;

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

    if (this.elicitation.hasPending(chatId)) {
      try {
        const confirmation = await this.elicitation.answer(chatId, text, this.gateway);
        if (confirmation) await this.send({ chatId, text: confirmation });
      } catch (e) {
        this.logger?.error?.(`feishu: elicitation answer error: ${e}`);
      }
      return;
    }

    const mapped = this.mapper.resolve({ chatId, text });

    if (mapped.command === "new" && !mapped.message) {
      await this.send({ chatId, text: "已创建新会话。" });
      return;
    }

    // Delegate system-level commands (e.g. /projects, /update, /status) to
    // the centralized registry — no need to handle them individually here.
    if (text.trim().startsWith("/")) {
      const handled = await executeChannelCommand(text, {
        gateway: this.gateway,
        chatId,
        channelKey: "feishu",
        reply: (msg) => this.send({ chatId, text: msg }),
        bindProject: (projectKey) => this.mapper.bindProject(chatId, projectKey),
        getProject: () => this.mapper.getProject(chatId),
        logger: this.logger as any,
      });
      if (handled) return;
    }

    if (!mapped.message) return;

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`feishu: chat ${chatId} already active, skipping`);
      return;
    }

    const reactionId = messageId ? await this.addReaction(messageId) : undefined;

    this.activeChats.add(chatId);
    try {
      let activeRunId: string | undefined;
      let watchdogSettled = false;
      const liveReply = new ImLiveReplyController<FeishuLiveMessageHandle>({
        ...this.liveReplyOptions,
        transport: this.createLiveReplyTransport(chatId),
        onTransportError: (error, phase) => {
          this.logger?.warn?.(`feishu: live reply ${phase} failed: ${error}`);
        },
      });
      const turnTimeoutMs = this.liveReplyOptions?.turnTimeoutMs ?? 600_000;
      const watchdog = turnTimeoutMs > 0
        ? setTimeout(() => {
            if (watchdogSettled) return;
            watchdogSettled = true;
            this.logger?.warn?.(`feishu: live reply timed out for chat ${chatId}`);
            void liveReply.markTimedOut().catch((error: unknown) => {
              this.logger?.warn?.(`feishu: mark timeout failed: ${error}`);
            });
            void this.gateway?.abortTurn({ sessionKey: mapped.sessionKey, ...(activeRunId ? { runId: activeRunId } : {}) })
              .catch((error: unknown) => {
                this.logger?.warn?.(`feishu: abort timeout turn failed: ${error}`);
              });
          }, turnTimeoutMs)
        : undefined;
      watchdog?.unref?.();
      try {
        for await (const event of this.gateway.submitTurn({
          sessionKey: mapped.sessionKey,
          channelKey: "feishu",
          message: mapped.message,
          ...(mapped.projectKey ? { projectKey: mapped.projectKey } : {}),
        })) {
          if (event.type === "turn_started") {
            activeRunId = event.runId;
          }
          if (event.type === "elicitation_request") {
            const questionText = this.elicitation.capture(chatId, mapped.sessionKey, event);
            await liveReply.pauseActivity();
            await this.send({ chatId, text: questionText });
            continue;
          }
          if (event.type === "error" && event.code === "agent_aborted") {
            await liveReply.markAborted();
            continue;
          }
          await liveReply.handleEvent(event);
        }
      } catch (e) {
        this.logger?.error?.(`feishu: submitTurn error: ${e}`);
        await liveReply.handleEvent({
          type: "error",
          message: "处理消息时发生错误，请重试。",
          recoverable: true,
        });
      } finally {
        watchdogSettled = true;
        if (watchdog) clearTimeout(watchdog);
      }

      this.elicitation.clear(chatId);
      await liveReply.flushFinal();
    } finally {
      if (reactionId && messageId) {
        await this.removeReaction(messageId, reactionId);
      }
      this.activeChats.delete(chatId);
    }
  }

  private createLiveReplyTransport(chatId: string): ImLiveReplyTransport<FeishuLiveMessageHandle> {
    const liveCursor = this.liveReplyOptions?.cursor ?? DEFAULT_LIVE_REPLY_CURSOR;
    return {
      maxMessageLength: MAX_TEXT_MESSAGE_LENGTH,
      send: async (text) => {
        const messageId = text.endsWith(liveCursor)
          ? await this.sendLiveMessage({ chatId, text })
          : await this.sendTextMessage({ chatId, text });
        if (messageId === false) return false;
        return messageId ? { messageId } : undefined;
      },
      edit: async (handle, text) => {
        return this.editLiveMessage(handle.messageId, text);
      },
    };
  }

  private async send(message: FeishuOutboundMessage): Promise<void> {
    await this.sendTextMessage(message);
  }

  private async sendLiveMessage(message: FeishuOutboundMessage): Promise<string | undefined | false> {
    return this.sendCardMessage(message);
  }

  private async sendTextMessage(message: FeishuOutboundMessage): Promise<string | undefined | false> {
    if (this.explicitSend) {
      await this.explicitSend(message);
      return undefined;
    }
    if (!this.appId || !this.appSecret) {
      this.logger?.warn?.("feishu: cannot send — appId/appSecret missing");
      return false;
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
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.error?.(`feishu: send failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return json.data?.message_id;
    } catch (e) {
      this.logger?.error?.(`feishu: send threw: ${e}`);
    }
    return false;
  }

  private async sendCardMessage(message: FeishuOutboundMessage): Promise<string | undefined | false> {
    if (this.explicitSend) {
      await this.explicitSend(message);
      return undefined;
    }
    if (!this.appId || !this.appSecret) {
      this.logger?.warn?.("feishu: cannot send live card — appId/appSecret missing");
      return false;
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
          msg_type: "interactive",
          content: JSON.stringify(buildLiveReplyCard(message.text)),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.error?.(`feishu: send live card failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return json.data?.message_id;
    } catch (e) {
      this.logger?.error?.(`feishu: send live card threw: ${e}`);
    }
    return false;
  }

  private async editLiveMessage(messageId: string, text: string): Promise<boolean> {
    if (!messageId || !this.appId || !this.appSecret) return false;

    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(`${UPDATE_MESSAGE_URL}/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: "interactive",
          content: JSON.stringify(buildLiveReplyCard(text)),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.warn?.(`feishu: update message failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger?.warn?.(`feishu: update message threw: ${e}`);
      return false;
    }
  }

  private async addReaction(messageId: string): Promise<string | undefined> {
    if (!this.appId || !this.appSecret) return undefined;
    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(`${REACTION_URL}/${messageId}/reactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reaction_type: { emoji_type: PROCESSING_EMOJI } }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        data?: { reaction_id?: string };
      };
      if (json.code === 0 && json.data?.reaction_id) {
        return json.data.reaction_id;
      }
      this.logger?.info?.(`feishu: addReaction non-zero code=${json.code}`);
    } catch (e) {
      this.logger?.info?.(`feishu: addReaction failed: ${e}`);
    }
    return undefined;
  }

  private async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!this.appId || !this.appSecret) return;
    try {
      const token = await this.getTenantAccessToken();
      await fetch(`${REACTION_URL}/${messageId}/reactions/${reactionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      this.logger?.info?.(`feishu: removeReaction failed: ${e}`);
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
  if (!chatId || content === undefined) return undefined;

  const text = extractTextContent(content);
  return { kind: "message", eventId: header.event_id, chatId, text, messageId: event.message.message_id };
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

function buildLiveReplyCard(text: string): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: text || " ",
        },
      },
    ],
  };
}

function maskAppId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
