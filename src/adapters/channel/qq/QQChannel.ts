import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { QQBotGateway, type QQBotCredentials, type QQGroupMessageEvent, type QQC2CMessageEvent } from "./qqbot-gateway.js";
import { QQSessionMapper } from "./QQSessionMapper.js";
import { renderQQEvent } from "./qq-render.js";

export type QQChannelOptions = {
  appId?: string;
  clientSecret?: string;
  allowGroups?: string[];
  triggerPrefixes?: string[];
  mapper?: QQSessionMapper;
  maxMessageLength?: number;
};

const DEFAULT_PREFIXES = ["/ask", "/chat"];
const DEFAULT_MAX_MSG_LEN = 2000;

export class QQChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "qq";

  private readonly credentials: QQBotCredentials;
  private readonly allowGroups: string[];
  private readonly triggerPrefixes: string[];
  private readonly mapper: QQSessionMapper;
  private readonly maxMessageLength: number;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private botGateway?: QQBotGateway;
  private activeChats = new Set<string>();

  constructor(options: QQChannelOptions = {}) {
    this.credentials = {
      appId: options.appId ?? process.env.QQ_BOT_APPID ?? "",
      clientSecret: options.clientSecret ?? process.env.QQ_BOT_SECRET ?? "",
    };
    this.allowGroups = options.allowGroups ?? this.parseEnvList(process.env.QQ_ALLOW_GROUPS) ?? ["*"];
    this.triggerPrefixes = options.triggerPrefixes ?? DEFAULT_PREFIXES;
    this.mapper = options.mapper ?? new QQSessionMapper();
    this.maxMessageLength = options.maxMessageLength ?? DEFAULT_MAX_MSG_LEN;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!this.credentials.appId || !this.credentials.clientSecret) {
      this.logger?.info?.("qq: QQ_BOT_APPID or QQ_BOT_SECRET not set, QQ channel disabled.");
      return { stop: async () => undefined };
    }

    this.botGateway = new QQBotGateway(this.credentials);

    this.botGateway.on("connected", () => {
      this.logger?.info?.("qq: WebSocket connected to QQ Gateway");
    });

    this.botGateway.on("ready", () => {
      this.logger?.info?.("qq: authenticated, listening for group messages");
    });

    this.botGateway.on("resumed", () => {
      this.logger?.info?.("qq: session resumed");
    });

    this.botGateway.on("disconnected", ({ code }: { code: number }) => {
      this.logger?.warn?.(`qq: disconnected (code=${code}), will reconnect...`);
    });

    this.botGateway.on("reconnecting", () => {
      this.logger?.info?.("qq: reconnecting...");
    });

    this.botGateway.on("error", (err: Error) => {
      this.logger?.error?.(`qq: error: ${err.message}`);
    });

    this.botGateway.on("raw_dispatch", (event: { type: string; data: unknown }) => {
      this.logger?.info?.(`qq: [dispatch] type=${event.type} data=${JSON.stringify(event.data).slice(0, 200)}`);
    });

    this.botGateway.on("group_message", (event: QQGroupMessageEvent) => {
      this.logger?.info?.(`qq: [group_msg] group=${event.group_openid} user=${event.author.member_openid} content="${event.content}"`);
      void this.handleGroupMessage(event);
    });

    this.botGateway.on("c2c_message", (event: QQC2CMessageEvent) => {
      this.logger?.info?.(`qq: [c2c_msg] user=${event.author.user_openid} content="${event.content}"`);
      void this.handleC2CMessage(event);
    });

    try {
      await this.botGateway.connect();
      this.logger?.info?.(`qq: connecting to QQ Official Bot Gateway (appId=${this.credentials.appId})...`);
    } catch (e) {
      this.logger?.error?.(`qq: failed to connect: ${e}`);
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`qq: stopping (${reason ?? "no reason"})`);
        this.botGateway?.close();
        this.botGateway = undefined;
      },
    };
  }

  private async handleGroupMessage(event: QQGroupMessageEvent): Promise<void> {
    const groupOpenId = event.group_openid;
    const userOpenId = event.author.member_openid;
    if (!groupOpenId || !userOpenId) return;

    if (!this.isGroupAllowed(groupOpenId)) return;

    const rawText = (event.content ?? "").trim();
    if (!rawText) return;

    const text = this.extractText(rawText);
    if (!text) return;

    const chatKey = `${groupOpenId}:${userOpenId}`;
    if (this.activeChats.has(chatKey)) {
      this.logger?.info?.(`qq: chat ${chatKey} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ groupId: groupOpenId, userId: userOpenId, text });

    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(groupOpenId, "已创建新会话。", event.id);
      return;
    }

    if (!mapped.message) return;

    this.activeChats.add(chatKey);
    try {
      await this.processMessage(groupOpenId, mapped.sessionKey, mapped.message, event.id);
    } finally {
      this.activeChats.delete(chatKey);
    }
  }

  private async handleC2CMessage(event: QQC2CMessageEvent): Promise<void> {
    const userOpenId = event.author.user_openid;
    if (!userOpenId) return;

    const rawText = (event.content ?? "").trim();
    if (!rawText) return;

    const chatKey = `c2c:${userOpenId}`;
    if (this.activeChats.has(chatKey)) {
      this.logger?.info?.(`qq: c2c ${chatKey} already active, skipping`);
      return;
    }

    const sessionKey = `qq:c2c:${userOpenId}:general`;
    this.activeChats.add(chatKey);
    try {
      await this.processC2CMessage(userOpenId, sessionKey, rawText, event.id);
    } finally {
      this.activeChats.delete(chatKey);
    }
  }

  private async processC2CMessage(
    userOpenId: string,
    sessionKey: string,
    message: string,
    msgId: string,
  ): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "qq",
        message,
      })) {
        const fragment = renderQQEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`qq: submitTurn error (c2c): ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendC2CReplyChunked(userOpenId, finalText, msgId);
    }
  }

  private async sendC2CReply(userOpenId: string, text: string, msgId?: string, msgSeq?: number): Promise<void> {
    if (!this.botGateway) return;
    try {
      await this.botGateway.sendC2CMessage(userOpenId, text, msgId, msgSeq);
    } catch (e) {
      this.logger?.error?.(`qq: sendC2CMessage failed: ${e}`);
    }
  }

  private async sendC2CReplyChunked(userOpenId: string, text: string, msgId: string): Promise<void> {
    const chunks = this.splitText(text, this.maxMessageLength);
    for (let i = 0; i < chunks.length; i++) {
      await this.sendC2CReply(userOpenId, chunks[i], msgId, i + 1);
      if (chunks.length > 1) {
        await this.sleep(500);
      }
    }
  }

  private extractText(raw: string): string | null {
    for (const prefix of this.triggerPrefixes) {
      if (raw.startsWith(prefix)) {
        const text = raw.slice(prefix.length).trim();
        return text || null;
      }
    }
    // GROUP_AT_MESSAGE_CREATE already implies @bot, so all messages here are triggered
    return raw;
  }

  private async processMessage(
    groupOpenId: string,
    sessionKey: string,
    message: string,
    msgId: string,
  ): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "qq",
        message,
      })) {
        const fragment = renderQQEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`qq: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReplyChunked(groupOpenId, finalText, msgId);
    }
  }

  private async sendReply(groupOpenId: string, text: string, msgId?: string, msgSeq?: number): Promise<void> {
    if (!this.botGateway) return;
    try {
      await this.botGateway.sendGroupMessage(groupOpenId, text, msgId, msgSeq);
    } catch (e) {
      this.logger?.error?.(`qq: sendGroupMessage failed: ${e}`);
    }
  }

  private async sendReplyChunked(groupOpenId: string, text: string, msgId: string): Promise<void> {
    const chunks = this.splitText(text, this.maxMessageLength);
    for (let i = 0; i < chunks.length; i++) {
      await this.sendReply(groupOpenId, chunks[i], msgId, i + 1);
      if (chunks.length > 1) {
        await this.sleep(500);
      }
    }
  }

  private splitText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt < maxLen * 0.3) {
        splitAt = maxLen;
      }
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, "");
    }
    return chunks;
  }

  private isGroupAllowed(groupOpenId: string): boolean {
    if (this.allowGroups.includes("*")) return true;
    return this.allowGroups.includes(groupOpenId);
  }

  private parseEnvList(value: string | undefined): string[] | undefined {
    if (!value) return undefined;
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
