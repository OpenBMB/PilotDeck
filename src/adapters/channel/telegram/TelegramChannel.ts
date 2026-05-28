import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { TelegramSessionMapper } from "./TelegramSessionMapper.js";
import { renderTelegramEvent } from "./telegram-render.js";

let Bot: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Bot = require("grammy").Bot;
} catch {
  // grammy not installed — start() will warn
}

const MAX_MESSAGE_LENGTH = 4096;

export type TelegramChannelOptions = {
  token?: string;
  webhookUrl?: string;
  mapper?: TelegramSessionMapper;
};

export class TelegramChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "telegram";

  private readonly mapper: TelegramSessionMapper;
  private readonly token?: string;
  private readonly webhookUrl?: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private bot: any = null;
  private activeChats = new Set<string>();

  constructor(options: TelegramChannelOptions = {}) {
    this.mapper = options.mapper ?? new TelegramSessionMapper();
    this.token = options.token ?? process.env.TELEGRAM_BOT_TOKEN;
    this.webhookUrl = options.webhookUrl;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!Bot) {
      this.logger?.error?.("telegram: grammy not installed; run `npm install grammy`");
      return { stop: async () => undefined };
    }
    if (!this.token) {
      this.logger?.error?.("telegram: TELEGRAM_BOT_TOKEN not set");
      return { stop: async () => undefined };
    }

    try {
      this.bot = new Bot(this.token);
      this.bot.on("message:text", (ctx: any) => this.handleTextMessage(ctx));
      this.bot.catch((err: any) => {
        this.logger?.error?.(`telegram: bot error: ${err}`);
      });

      if (this.webhookUrl) {
        await this.bot.api.setWebhook(this.webhookUrl);
        this.logger?.info?.(`telegram: webhook mode at ${this.webhookUrl}`);
      } else {
        await this.bot.api.deleteWebhook();
        this.bot.start({ drop_pending_updates: false });
        this.logger?.info?.("telegram: long-polling started");
      }

      const me = await this.bot.api.getMe();
      this.logger?.info?.(`telegram: connected as @${me.username}`);
    } catch (e) {
      this.logger?.error?.(`telegram: start failed: ${e}`);
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`telegram: stopping (${reason ?? "no reason"})`);
        if (this.bot) {
          try { await this.bot.stop(); } catch { /* best effort */ }
          this.bot = null;
        }
      },
    };
  }

  private async handleTextMessage(ctx: any): Promise<void> {
    const msg = ctx.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`telegram: chat ${chatId} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId, text: msg.text });
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

  private async processMessage(chatId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    void this.sendTyping(chatId);

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "telegram",
        message,
      })) {
        const fragment = renderTelegramEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`telegram: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.bot) return;
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk);
      } catch (e) {
        this.logger?.error?.(`telegram: sendMessage failed: ${e}`);
      }
    }
  }

  private async sendTyping(chatId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendChatAction(chatId, "typing");
    } catch { /* best effort */ }
  }
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
