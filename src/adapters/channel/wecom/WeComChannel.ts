import { randomUUID } from "node:crypto";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { WeComSessionMapper } from "./WeComSessionMapper.js";
import { renderWeComEvent } from "./wecom-render.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import { executeChannelCommand } from "../protocol/ChannelCommandRegistry.js";
import WebSocket from "ws";

const DEFAULT_WS_URL = "wss://openws.work.weixin.qq.com";
const APP_CMD_SUBSCRIBE = "aibot_subscribe";
const APP_CMD_CALLBACK = "aibot_msg_callback";
const APP_CMD_SEND = "aibot_send_msg";
const APP_CMD_RESPONSE = "aibot_respond_msg";
const APP_CMD_PING = "ping";
const APP_CMD_EVENT_CALLBACK = "aibot_event_callback";
const CALLBACK_COMMANDS = new Set([APP_CMD_CALLBACK]);
const NON_RESPONSE_COMMANDS = new Set([...CALLBACK_COMMANDS, APP_CMD_EVENT_CALLBACK]);
const MAX_MESSAGE_LENGTH = 4000;
const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const;
const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX_SIZE = 1000;
const WS_OPEN = 1;

type WeComAccessPolicy = "open" | "allowlist" | "disabled" | "pairing";

type PendingRequest = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type WeComChannelOptions = {
  botKey?: string;
  extra?: Record<string, unknown>;
  mapper?: WeComSessionMapper;
  webSocketCtor?: any;
  uuid?: () => string;
  reconnectBackoffMs?: readonly number[];
};

export class WeComChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "wecom";

  private readonly mapper: WeComSessionMapper;
  private readonly botId: string;
  private readonly botSecret: string;
  private readonly wsUrl: string;
  private readonly webSocketCtor: any;
  private readonly uuid: () => string;
  private readonly reconnectBackoffMs: readonly number[];
  private readonly deviceId: string;
  private readonly dmPolicy: WeComAccessPolicy;
  private readonly allowFrom: string[];
  private readonly groupPolicy: WeComAccessPolicy;
  private readonly groupAllowFrom: string[];
  private readonly groups: Record<string, unknown>;
  private readonly groupSessionsPerUser: boolean;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private ws: any = null;
  private pending = new Map<string, PendingRequest>();
  private replyReqIds = new Map<string, string>();
  private lastChatReqIds = new Map<string, string>();
  private seenMessages = new Map<string, number>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalStop = false;
  private activeChats = new Set<string>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();

  constructor(options: WeComChannelOptions = {}) {
    this.mapper = options.mapper ?? new WeComSessionMapper();
    const ex = options.extra ?? {};
    this.botId = String(
      options.botKey ?? ex.bot_id ?? ex.botId ?? process.env.WECOM_BOT_ID ?? "",
    ).trim();
    this.botSecret = String(
      ex.botSecret ?? ex.secret ?? process.env.WECOM_SECRET ?? "",
    ).trim();
    this.wsUrl = (String(
      ex.websocket_url ?? ex.websocketUrl ?? process.env.WECOM_WEBSOCKET_URL ?? "",
    ).trim() || DEFAULT_WS_URL);
    this.webSocketCtor = options.webSocketCtor ?? WebSocket;
    this.uuid = options.uuid ?? randomUUID;
    this.reconnectBackoffMs = options.reconnectBackoffMs ?? RECONNECT_BACKOFF_MS;
    this.deviceId = this.uuid().replace(/-/g, "");
    this.dmPolicy = normalizePolicy(ex.dm_policy ?? ex.dmPolicy ?? process.env.WECOM_DM_POLICY ?? "pairing");
    this.allowFrom = coerceList(ex.allow_from ?? ex.allowFrom ?? process.env.WECOM_ALLOWED_USERS ?? "");
    this.groupPolicy = normalizePolicy(ex.group_policy ?? ex.groupPolicy ?? process.env.WECOM_GROUP_POLICY ?? "pairing");
    this.groupAllowFrom = coerceList(ex.group_allow_from ?? ex.groupAllowFrom);
    this.groups = isRecord(ex.groups) ? ex.groups : {};
    this.groupSessionsPerUser = typeof ex.group_sessions_per_user === "boolean"
      ? ex.group_sessions_per_user
      : typeof ex.groupSessionsPerUser === "boolean"
        ? ex.groupSessionsPerUser
        : true;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!this.webSocketCtor) {
      this.logger?.error?.("wecom: `ws` package not installed; run `npm install ws`");
      return { stop: async () => undefined };
    }
    if (!this.botId || !this.botSecret) {
      this.logger?.error?.("wecom: botKey (bot_id) and secret are required");
      return { stop: async () => undefined };
    }

    try {
      this.intentionalStop = false;
      await this.connectWs();
      this.logger?.info?.(`wecom: connected to ${this.wsUrl} as bot ${this.botId}`);
    } catch (e) {
      this.logger?.error?.(`wecom: start failed: ${e}`);
      this.intentionalStop = true;
      this.failPending(new Error("WeCom startup failed"));
      await this.cleanupWs();
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`wecom: stopping (${reason ?? "no reason"})`);
        this.intentionalStop = true;
        this.stopHeartbeat();
        this.clearReconnectTimer();
        this.failPending(new Error("WeCom adapter stopped"));
        this.replyReqIds.clear();
        this.lastChatReqIds.clear();
        this.seenMessages.clear();
        await this.cleanupWs();
      },
    };
  }

  private async connectWs(): Promise<void> {
    await this.cleanupWs();
    this.ws = new this.webSocketCtor(this.wsUrl);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WeCom WebSocket connect timeout")), CONNECT_TIMEOUT_MS);
      this.ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.once("error", (err: unknown) => {
        clearTimeout(t);
        reject(err);
      });
    });

    this.ws.on("message", (data: any) => {
      void this.onSocketData(data.toString()).catch((e: unknown) => {
        this.logger?.error?.(`wecom: message handling failed: ${e}`);
      });
    });
    this.ws.on("close", () => {
      this.stopHeartbeat();
      this.failPending(new Error("WeCom connection interrupted"));
      if (!this.intentionalStop) {
        this.logger?.warn?.("wecom: WebSocket closed");
        this.scheduleReconnect();
      }
    });
    this.ws.on("error", (err: unknown) => {
      this.logger?.error?.(`wecom: WebSocket error: ${err}`);
    });

    const reqId = this.newReqId("subscribe");
    const authPromise = this.waitForReq(reqId, CONNECT_TIMEOUT_MS);
    await this.sendJson({
      cmd: APP_CMD_SUBSCRIBE,
      headers: { req_id: reqId },
      body: { bot_id: this.botId, secret: this.botSecret, device_id: this.deviceId },
    });

    const auth = await authPromise;
    const body = (auth as { body?: { errcode?: number; errmsg?: string } }).body;
    const errcode = body?.errcode ?? (auth as { errcode?: number }).errcode;
    if (errcode != null && errcode !== 0) {
      const errmsg = body?.errmsg ?? (auth as { errmsg?: string }).errmsg ?? "auth failed";
      throw new Error(`${errmsg} (errcode=${errcode})`);
    }

    this.reconnectAttempt = 0;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendPingFrame();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async cleanupWs(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { /* best effort */ }
      this.ws = null;
    }
  }

  private newReqId(prefix: string): string {
    return `${prefix}-${this.uuid().replace(/-/g, "")}`;
  }

  private payloadReqId(payload: Record<string, unknown>): string {
    const h = payload.headers as Record<string, unknown> | undefined;
    return String(h?.req_id ?? "");
  }

  private async sendJson(payload: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error("WeCom websocket is not connected");
    }
    this.ws.send(JSON.stringify(payload));
  }

  private async waitForReq(reqId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("Timeout waiting for WeCom response"));
      }, timeoutMs);
      t.unref?.();
      this.pending.set(reqId, {
        resolve: (p) => {
          clearTimeout(t);
          this.pending.delete(reqId);
          resolve(p);
        },
        reject: (error) => {
          clearTimeout(t);
          this.pending.delete(reqId);
          reject(error);
        },
        timeout: t,
      });
    });
  }

  private failPending(error: Error): void {
    for (const [reqId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(reqId);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalStop || this.reconnectTimer) return;
    const delay = this.reconnectBackoffMs[Math.min(this.reconnectAttempt, this.reconnectBackoffMs.length - 1)] ?? 60_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectWs()
        .then(() => {
          this.logger?.info?.("wecom: reconnected");
        })
        .catch((e: unknown) => {
          this.logger?.warn?.(`wecom: reconnect failed: ${e}`);
          void this.cleanupWs().finally(() => this.scheduleReconnect());
        });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private settlePending(reqId: string, payload: Record<string, unknown>): boolean {
    const pending = this.pending.get(reqId);
    if (!pending) return false;
    pending.resolve(payload);
    return true;
  }

  private isDuplicateMessage(messageId: string): boolean {
    const now = Date.now();
    for (const [id, seenAt] of this.seenMessages.entries()) {
      if (now - seenAt > DEDUP_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }
    if (this.seenMessages.has(messageId)) return true;
    this.seenMessages.set(messageId, now);
    while (this.seenMessages.size > DEDUP_MAX_SIZE) {
      const first = this.seenMessages.keys().next().value;
      if (!first) break;
      this.seenMessages.delete(first);
    }
    return false;
  }

  private rememberReplyReqId(messageId: string, reqId: string): void {
    const mid = messageId.trim();
    const rid = reqId.trim();
    if (!mid || !rid) return;
    this.replyReqIds.set(mid, rid);
    trimMap(this.replyReqIds, DEDUP_MAX_SIZE);
  }

  private rememberChatReqId(chatId: string, reqId: string): void {
    const cid = chatId.trim();
    const rid = reqId.trim();
    if (!cid || !rid) return;
    this.lastChatReqIds.set(cid, rid);
    trimMap(this.lastChatReqIds, DEDUP_MAX_SIZE);
  }

  private interactionKey(chatId: string, userId: string, chatType: "dm" | "group"): string {
    if (chatType === "group" && this.groupSessionsPerUser && userId) {
      return `${chatId}:${userId}`;
    }
    return chatId;
  }

  private stripLeadingMention(text: string): string {
    return text.replace(/^@\S+\s*/, "").trim();
  }

  private isDmAllowed(senderId: string): boolean {
    if (!senderId) return false;
    if (this.dmPolicy === "disabled") return false;
    if (this.dmPolicy === "allowlist") return entryMatches(this.allowFrom, senderId);
    if (this.dmPolicy === "open") return true;
    this.logger?.warn?.("wecom: dm_policy=pairing is not supported in PilotDeck; DM ignored");
    return false;
  }

  private isGroupAllowed(chatId: string, senderId: string): boolean {
    if (!chatId) return false;
    if (this.groupPolicy === "disabled") return false;
    if (this.groupPolicy === "pairing") {
      this.logger?.warn?.("wecom: group_policy=pairing is not supported in PilotDeck; group message ignored");
      return false;
    }
    if (this.groupPolicy === "allowlist" && !entryMatches(this.groupAllowFrom, chatId)) {
      return false;
    }

    const groupCfg = this.resolveGroupConfig(chatId);
    const senderAllow = coerceList(groupCfg.allow_from ?? groupCfg.allowFrom);
    if (senderAllow.length > 0) {
      return entryMatches(senderAllow, senderId);
    }
    return true;
  }

  private resolveGroupConfig(chatId: string): Record<string, unknown> {
    const exact = this.groups[chatId];
    if (isRecord(exact)) return exact;
    const lowered = chatId.toLowerCase();
    for (const [key, value] of Object.entries(this.groups)) {
      if (key.toLowerCase() === lowered && isRecord(value)) return value;
    }
    const wildcard = this.groups["*"];
    return isRecord(wildcard) ? wildcard : {};
  }

  private async handleCommandIfNeeded(
    text: string,
    chatId: string,
    chatType: "dm" | "group",
    messageId: string,
  ): Promise<boolean> {
    if (!this.gateway || !text.trim().startsWith("/")) return false;
    return executeChannelCommand(text, {
      gateway: this.gateway,
      chatId,
      channelKey: "wecom",
      reply: (msg) => this.sendReply(chatId, msg, { chatType, replyToMessageId: messageId }),
      logger: this.logger,
    });
  }

  private async onSocketData(raw: string): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const reqId = this.payloadReqId(payload);
    const cmd = String(payload.cmd ?? "");

    if (reqId && !NON_RESPONSE_COMMANDS.has(cmd) && this.settlePending(reqId, payload)) {
      return;
    }

    if (CALLBACK_COMMANDS.has(cmd)) {
      await this.onBotCallback(payload);
    }
  }

  private async onBotCallback(payload: Record<string, unknown>): Promise<void> {
    const body = payload.body as Record<string, unknown> | undefined;
    if (!body) return;

    const inboundReq = this.payloadReqId(payload);
    const messageId = String(body.msgid ?? inboundReq ?? this.uuid()).trim();
    if (this.isDuplicateMessage(messageId)) {
      this.logger?.info?.(`wecom: duplicate message ${messageId} ignored`);
      return;
    }

    const sender = (body.from as Record<string, unknown> | undefined) ?? {};
    const senderId = String(sender.userid ?? "").trim();
    const chatId = String(body.chatid ?? senderId).trim();
    if (!chatId) return;

    const chatType = String(body.chattype ?? "").toLowerCase() === "group" ? "group" : "dm";
    if (chatType === "group") {
      if (!this.isGroupAllowed(chatId, senderId)) return;
    } else if (!this.isDmAllowed(senderId)) {
      return;
    }

    if (inboundReq) {
      this.rememberReplyReqId(messageId, inboundReq);
      this.rememberChatReqId(chatId, inboundReq);
    }

    const extractedText = this.extractText(body);
    const text = chatType === "group" ? this.stripLeadingMention(extractedText) : extractedText;
    if (!text.trim()) return;

    const interactionKey = this.interactionKey(chatId, senderId, chatType);
    if (this.elicitation.hasPending(interactionKey) && this.gateway) {
      try {
        const confirmation = await this.elicitation.answer(interactionKey, text, this.gateway);
        if (confirmation) await this.sendReply(chatId, confirmation, { chatType, replyToMessageId: messageId });
      } catch (e) {
        this.logger?.error?.(`wecom: elicitation answer error: ${e}`);
      }
      return;
    }

    if (this.permissions.hasPending(interactionKey) && this.gateway) {
      try {
        const confirmation = await this.permissions.answer(interactionKey, text, this.gateway);
        if (confirmation) await this.sendReply(chatId, confirmation, { chatType, replyToMessageId: messageId });
      } catch (e) {
        this.logger?.error?.(`wecom: permission answer error: ${e}`);
      }
      return;
    }

    const mapped = this.mapper.resolve({
      chatId,
      text,
      userId: senderId,
      chatType,
      groupSessionsPerUser: this.groupSessionsPerUser,
    });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(chatId, "已创建新会话。", { chatType, replyToMessageId: messageId });
      return;
    }

    if (await this.handleCommandIfNeeded(text, chatId, chatType, messageId)) {
      return;
    }
    if (!mapped.message) return;

    if (this.activeChats.has(mapped.sessionKey)) {
      this.logger?.info?.(`wecom: session ${mapped.sessionKey} already active, skipping`);
      return;
    }

    this.activeChats.add(mapped.sessionKey);
    try {
      await this.processMessage({
        chatId,
        chatType,
        interactionKey,
        sessionKey: mapped.sessionKey,
        message: mapped.message,
        replyToMessageId: messageId,
      });
    } finally {
      this.activeChats.delete(mapped.sessionKey);
    }
  }

  private extractText(body: Record<string, unknown>): string {
    const parts: string[] = [];
    const msgtype = String(body.msgtype ?? "").toLowerCase();

    if (msgtype === "mixed") {
      const mixed = (body.mixed as Record<string, unknown> | undefined) ?? {};
      const items = (mixed.msg_item as unknown[]) ?? [];
      for (const item of items) {
        if (!isRecord(item)) continue;
        if (String(item.msgtype ?? "").toLowerCase() === "text") {
          const tb = (item.text as Record<string, unknown> | undefined) ?? {};
          const c = String(tb.content ?? "").trim();
          if (c) parts.push(c);
        }
      }
    } else {
      const tb = (body.text as Record<string, unknown> | undefined) ?? {};
      const c = String(tb.content ?? "").trim();
      if (c) parts.push(c);
    }

    return parts.join("\n").trim();
  }

  private async processMessage(input: {
    chatId: string;
    chatType: "dm" | "group";
    interactionKey: string;
    sessionKey: string;
    message: string;
    replyToMessageId: string;
  }): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey: input.sessionKey,
        channelKey: "wecom",
        message: input.message,
        allowPlanModeTools: false,
      })) {
        if (event.type === "elicitation_request") {
          const questionText = this.elicitation.capture(input.interactionKey, input.sessionKey, event);
          await this.sendReply(input.chatId, questionText, {
            chatType: input.chatType,
            replyToMessageId: input.replyToMessageId,
          });
          continue;
        }
        if (event.type === "permission_request") {
          const questionText = this.permissions.capture(input.interactionKey, input.sessionKey, event);
          if (questionText) await this.sendReply(input.chatId, questionText, {
            chatType: input.chatType,
            replyToMessageId: input.replyToMessageId,
          });
          continue;
        }
        const fragment = renderWeComEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`wecom: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    this.elicitation.clear(input.interactionKey);
    this.permissions.clear(input.interactionKey);
    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(input.chatId, finalText, {
        chatType: input.chatType,
        replyToMessageId: input.replyToMessageId,
      });
    }
  }

  private async sendReply(
    chatId: string,
    text: string,
    context: { chatType?: "dm" | "group"; replyToMessageId?: string } = {},
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      this.logger?.warn?.(`wecom: not connected, cannot send to ${chatId}`);
      return;
    }

    const slice = text.slice(0, MAX_MESSAGE_LENGTH);
    const replyReq = this.replyReqIdFor(chatId, context.replyToMessageId);

    try {
      const response = replyReq
        ? await this.sendMarkdownByReqId(replyReq, slice)
        : context.chatType === "group"
          ? undefined
          : await this.sendProactiveMarkdown(chatId, slice);

      if (!response) {
        this.logger?.warn?.(`wecom: no reply request id for group chat ${chatId}, cannot send proactive message`);
        return;
      }

      const err = this.responseError(response);
      if (err) {
        this.logger?.error?.(`wecom: sendReply error: ${err}`);
      }
    } catch (e) {
      this.logger?.error?.(`wecom: sendReply failed: ${e}`);
    }
  }

  private async sendMarkdownByReqId(reqId: string, text: string): Promise<Record<string, unknown>> {
    return this.sendReplyRequest(reqId, {
      msgtype: "markdown",
      markdown: { content: text.slice(0, MAX_MESSAGE_LENGTH) },
    });
  }

  private async sendProactiveMarkdown(chatId: string, text: string): Promise<Record<string, unknown>> {
    return this.sendRequest(APP_CMD_SEND, {
      chatid: chatId,
      msgtype: "markdown",
      markdown: { content: text.slice(0, MAX_MESSAGE_LENGTH) },
    });
  }

  private async sendRequest(cmd: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reqId = this.newReqId(cmd);
    const promise = this.waitForReq(reqId, REQUEST_TIMEOUT_MS);
    await this.sendJson({ cmd, headers: { req_id: reqId }, body });
    return promise;
  }

  private async sendReplyRequest(
    replyReqId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const rid = String(replyReqId).trim();
    if (!rid) throw new Error("reply_req_id is required");
    const promise = this.waitForReq(rid, REQUEST_TIMEOUT_MS);
    await this.sendJson({ cmd: APP_CMD_RESPONSE, headers: { req_id: rid }, body });
    return promise;
  }

  private async sendPingFrame(): Promise<void> {
    try {
      await this.sendJson({
        cmd: APP_CMD_PING,
        headers: { req_id: this.newReqId("ping") },
        body: {},
      });
    } catch {
      // Best effort heartbeat; close/error handlers drive reconnects.
    }
  }

  private replyReqIdFor(chatId: string, replyToMessageId?: string): string | undefined {
    if (replyToMessageId) {
      const reqId = this.replyReqIds.get(replyToMessageId);
      if (reqId) return reqId;
    }
    return this.lastChatReqIds.get(chatId);
  }

  private responseError(res: Record<string, unknown>): string | undefined {
    const body = res.body as Record<string, unknown> | undefined;
    const errcode = body?.errcode ?? (res as { errcode?: unknown }).errcode;
    if (errcode === 0 || errcode == null) return undefined;
    const errmsg = String(body?.errmsg ?? (res as { errmsg?: unknown }).errmsg ?? "error");
    return `WeCom errcode ${String(errcode)}: ${errmsg}`;
  }
}

function coerceList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizePolicy(value: unknown): WeComAccessPolicy {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "open" || raw === "allowlist" || raw === "disabled" || raw === "pairing") {
    return raw;
  }
  return "pairing";
}

function normalizeEntry(value: string): string {
  return value.trim().toLowerCase().replace(/^wecom:(user|group):/, "");
}

function entryMatches(entries: string[], value: string): boolean {
  const normalized = normalizeEntry(value);
  return entries.some((entry) => {
    const candidate = normalizeEntry(entry);
    return candidate === "*" || candidate === normalized;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function trimMap<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const first = map.keys().next().value;
    if (first == null) break;
    map.delete(first);
  }
}
