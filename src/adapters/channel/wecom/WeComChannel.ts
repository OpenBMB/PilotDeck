import { randomUUID } from "node:crypto";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { WeComSessionMapper } from "./WeComSessionMapper.js";
import { renderWeComEvent } from "./wecom-render.js";

let WebSocketCtor: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  WebSocketCtor = require("ws");
} catch {
  // ws not installed — start() will warn
}

const DEFAULT_WS_URL = "wss://openws.work.weixin.qq.com";
const APP_CMD_SUBSCRIBE = "aibot_subscribe";
const APP_CMD_CALLBACK = "aibot_msg_callback";
const APP_CMD_SEND = "aibot_send_msg";
const APP_CMD_RESPONSE = "aibot_respond_msg";
const APP_CMD_PING = "ping";
const CALLBACK_COMMANDS = new Set([APP_CMD_CALLBACK, "aibot_callback"]);
const NON_RESPONSE_COMMANDS = new Set([...CALLBACK_COMMANDS, "aibot_event_callback"]);
const MAX_MESSAGE_LENGTH = 4000;
const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export type WeComChannelOptions = {
  botKey?: string;
  extra?: Record<string, unknown>;
  mapper?: WeComSessionMapper;
};

export class WeComChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "wecom";

  private readonly mapper: WeComSessionMapper;
  private readonly botId: string;
  private readonly botSecret: string;
  private readonly wsUrl: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private ws: any = null;
  private pending = new Map<string, (p: Record<string, unknown>) => void>();
  private replyReqIds = new Map<string, string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private listenStopped = false;
  private activeChats = new Set<string>();

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
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!WebSocketCtor) {
      this.logger?.error?.("wecom: `ws` package not installed; run `npm install ws`");
      return { stop: async () => undefined };
    }
    if (!this.botId || !this.botSecret) {
      this.logger?.error?.("wecom: botKey (bot_id) and secret are required");
      return { stop: async () => undefined };
    }

    try {
      await this.connectWs();
      this.logger?.info?.(`wecom: connected to ${this.wsUrl} as bot ${this.botId}`);
    } catch (e) {
      this.logger?.error?.(`wecom: start failed: ${e}`);
      await this.cleanupWs();
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`wecom: stopping (${reason ?? "no reason"})`);
        this.listenStopped = true;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.pending.clear();
        this.replyReqIds.clear();
        await this.cleanupWs();
      },
    };
  }

  private async connectWs(): Promise<void> {
    this.ws = new WebSocketCtor(this.wsUrl);

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

    this.listenStopped = false;
    this.ws.on("message", (data: any) => void this.onSocketData(data.toString()));
    this.ws.on("close", () => {
      if (!this.listenStopped) {
        this.logger?.warn?.("wecom: WebSocket closed");
      }
    });
    this.ws.on("error", (err: unknown) => {
      this.logger?.error?.(`wecom: WebSocket error: ${err}`);
    });

    const reqId = this.newReqId("subscribe");
    await this.sendJson({
      cmd: APP_CMD_SUBSCRIBE,
      headers: { req_id: reqId },
      body: { bot_id: this.botId, secret: this.botSecret },
    });

    const auth = await this.waitForReq(reqId, CONNECT_TIMEOUT_MS);
    const body = (auth as { body?: { errcode?: number; errmsg?: string } }).body;
    const errcode = body?.errcode ?? (auth as { errcode?: number }).errcode;
    if (errcode != null && errcode !== 0) {
      const errmsg = body?.errmsg ?? (auth as { errmsg?: string }).errmsg ?? "auth failed";
      throw new Error(`${errmsg} (errcode=${errcode})`);
    }

    this.heartbeatTimer = setInterval(() => {
      void this.sendPingFrame();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async cleanupWs(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { /* best effort */ }
      this.ws = null;
    }
  }

  private newReqId(prefix: string): string {
    return `${prefix}-${randomUUID().replace(/-/g, "")}`;
  }

  private payloadReqId(payload: Record<string, unknown>): string {
    const h = payload.headers as Record<string, unknown> | undefined;
    return String(h?.req_id ?? "");
  }

  private async sendJson(payload: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== 1) {
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
      this.pending.set(reqId, (p) => {
        clearTimeout(t);
        this.pending.delete(reqId);
        resolve(p);
      });
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

    if (reqId && this.pending.has(reqId) && !NON_RESPONSE_COMMANDS.has(cmd)) {
      const fn = this.pending.get(reqId);
      if (fn) fn(payload);
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
    const sender = (body.from as Record<string, unknown> | undefined) ?? {};
    const senderId = String(sender.userid ?? "").trim();
    const chatId = String(body.chatid ?? senderId).trim();
    if (!chatId) return;

    if (inboundReq) this.replyReqIds.set(chatId, inboundReq);

    const text = this.extractText(body);
    if (!text.trim()) return;

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`wecom: chat ${chatId} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(chatId, "已创建新会话。");
      return;
    }
    if (!mapped.message) return;

    this.activeChats.add(chatId);
    try {
      await this.processMessage(chatId, mapped.sessionKey, mapped.message);
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private extractText(body: Record<string, unknown>): string {
    const parts: string[] = [];
    const msgtype = String(body.msgtype ?? "").toLowerCase();

    if (msgtype === "mixed") {
      const mixed = (body.mixed as Record<string, unknown> | undefined) ?? {};
      const items = (mixed.msg_item as unknown[]) ?? [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const it = item as Record<string, unknown>;
        if (String(it.msgtype ?? "").toLowerCase() === "text") {
          const tb = (it.text as Record<string, unknown> | undefined) ?? {};
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

  private async processMessage(chatId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "wecom",
        message,
      })) {
        const fragment = renderWeComEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`wecom: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== 1) {
      this.logger?.warn?.(`wecom: not connected, cannot send to ${chatId}`);
      return;
    }

    const slice = text.slice(0, MAX_MESSAGE_LENGTH);
    const replyReq = this.replyReqIds.get(chatId);

    try {
      let response: Record<string, unknown>;
      if (replyReq) {
        response = await this.sendReplyRequest(replyReq, {
          msgtype: "stream",
          stream: {
            id: this.newReqId("stream"),
            finish: true,
            content: slice,
          },
        });
        this.replyReqIds.delete(chatId);
      } else {
        response = await this.sendRequest(APP_CMD_SEND, {
          chatid: chatId,
          msgtype: "markdown",
          markdown: { content: slice },
        });
      }

      const err = this.responseError(response);
      if (err) {
        this.logger?.error?.(`wecom: sendReply error: ${err}`);
      }
    } catch (e) {
      this.logger?.error?.(`wecom: sendReply failed: ${e}`);
    }
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
    } catch { /* best effort */ }
  }

  private responseError(res: Record<string, unknown>): string | undefined {
    const body = res.body as Record<string, unknown> | undefined;
    const errcode = body?.errcode ?? (res as { errcode?: unknown }).errcode;
    if (errcode === 0 || errcode == null) return undefined;
    const errmsg = String(body?.errmsg ?? (res as { errmsg?: unknown }).errmsg ?? "error");
    return `WeCom errcode ${String(errcode)}: ${errmsg}`;
  }
}
