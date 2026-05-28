import { randomUUID } from "node:crypto";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { DingTalkSessionMapper } from "./DingTalkSessionMapper.js";
import { renderDingTalkEvent } from "./dingtalk-render.js";

let DingStream: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DingStream = require("dingtalk-stream");
} catch {
  // dingtalk-stream not installed — start() will warn
}

const MAX_MESSAGE_LENGTH = 20_000;
const WEBHOOK_RE = /^https:\/\/api\.dingtalk\.com\//;
const SESSION_WEBHOOKS_MAX = 500;
const SEEN_IDS_MAX = 2000;

export type DingTalkChannelOptions = {
  clientId?: string;
  clientSecret?: string;
  mapper?: DingTalkSessionMapper;
};

export class DingTalkChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "dingtalk";

  private readonly mapper: DingTalkSessionMapper;
  private readonly clientId: string;
  private readonly clientSecret: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client: any = null;
  private activeChats = new Set<string>();
  private sessionWebhooks = new Map<string, string>();
  private seenIds = new Set<string>();

  constructor(options: DingTalkChannelOptions = {}) {
    this.mapper = options.mapper ?? new DingTalkSessionMapper();
    this.clientId = String(options.clientId ?? process.env.DINGTALK_CLIENT_ID ?? "").trim();
    this.clientSecret = String(options.clientSecret ?? process.env.DINGTALK_CLIENT_SECRET ?? "").trim();
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!DingStream) {
      this.logger?.error?.("dingtalk: dingtalk-stream not installed; run `npm install dingtalk-stream`");
      return { stop: async () => undefined };
    }
    if (!this.clientId || !this.clientSecret) {
      this.logger?.error?.("dingtalk: clientId and clientSecret are required");
      return { stop: async () => undefined };
    }

    try {
      this.client = new DingStream.DWClient({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        debug: Boolean(process.env.DINGTALK_STREAM_DEBUG),
      });

      this.client.registerAllEventListener((msg: any) => {
        void this.onDownstream(msg).catch((e: unknown) => {
          this.logger?.error?.(`dingtalk: onDownstream error: ${e}`);
        });
        return { status: DingStream.EventAck.SUCCESS };
      });

      await this.client.connect();
      this.logger?.info?.("dingtalk: connected via Stream mode");
    } catch (e) {
      this.logger?.error?.(`dingtalk: start failed: ${e}`);
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`dingtalk: stopping (${reason ?? "no reason"})`);
        if (this.client) {
          try { this.client.disconnect(); } catch { /* best effort */ }
          this.client = null;
        }
        this.sessionWebhooks.clear();
        this.seenIds.clear();
      },
    };
  }

  private async onDownstream(msg: any): Promise<void> {
    const topic = String(msg?.headers?.topic ?? "");
    if (topic && DingStream && topic !== DingStream.TOPIC_ROBOT) return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(msg.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const msgId = String(data.msgId ?? data.messageId ?? msg.headers?.messageId ?? randomUUID());
    if (this.seenIds.has(msgId)) return;
    this.seenIds.add(msgId);
    if (this.seenIds.size > SEEN_IDS_MAX) {
      const first = this.seenIds.values().next().value;
      if (first) this.seenIds.delete(first as string);
    }

    const text = this.extractText(data);
    if (!text.trim()) return;

    const conversationId = String(data.conversationId ?? "");
    const senderId = String(data.senderId ?? "");
    const chatId = conversationId || senderId;
    if (!chatId) return;

    const webhook = String(data.sessionWebhook ?? "");
    if (webhook && WEBHOOK_RE.test(webhook)) {
      this.rememberWebhook(chatId, webhook);
    }

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`dingtalk: chat ${chatId} already active, skipping`);
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

  private extractText(data: Record<string, unknown>): string {
    const t = data.text;
    if (t && typeof t === "object" && "content" in (t as object)) {
      return String((t as { content?: string }).content ?? "").trim();
    }
    if (typeof t === "string") return t.trim();

    const rich = (data.richText ?? data.rich_text) as unknown;
    if (Array.isArray(rich)) {
      const parts = rich
        .filter((x): x is Record<string, unknown> => x != null && typeof x === "object")
        .map((x) => String(x.text ?? ""))
        .filter(Boolean);
      return parts.join(" ").trim();
    }
    return "";
  }

  private rememberWebhook(chatId: string, url: string): void {
    if (this.sessionWebhooks.size >= SESSION_WEBHOOKS_MAX) {
      const k = this.sessionWebhooks.keys().next().value;
      if (k) this.sessionWebhooks.delete(k);
    }
    this.sessionWebhooks.set(chatId, url);
  }

  private async processMessage(chatId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "dingtalk",
        message,
      })) {
        const fragment = renderDingTalkEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`dingtalk: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    const sessionWebhook = this.sessionWebhooks.get(chatId);
    if (!sessionWebhook) {
      this.logger?.warn?.(`dingtalk: no sessionWebhook for chat ${chatId}, cannot send`);
      return;
    }
    if (!WEBHOOK_RE.test(sessionWebhook)) {
      this.logger?.warn?.(`dingtalk: sessionWebhook for ${chatId} failed origin check`);
      return;
    }

    const payload = {
      msgtype: "markdown",
      markdown: {
        title: "Reply",
        text: text.slice(0, MAX_MESSAGE_LENGTH),
      },
    };

    try {
      const res = await fetch(sessionWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text();
        this.logger?.error?.(`dingtalk: sendReply HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    } catch (e) {
      this.logger?.error?.(`dingtalk: sendReply failed: ${e}`);
    }
  }
}
