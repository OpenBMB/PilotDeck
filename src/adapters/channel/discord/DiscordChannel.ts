import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { DiscordSessionMapper } from "./DiscordSessionMapper.js";
import { renderDiscordEvent } from "./discord-render.js";

let DiscordLib: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DiscordLib = require("discord.js");
} catch {
  // discord.js not installed — start() will warn
}

const MAX_MESSAGE_LENGTH = 2000;

export type DiscordChannelOptions = {
  token?: string;
  mapper?: DiscordSessionMapper;
};

export class DiscordChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "discord";

  private readonly mapper: DiscordSessionMapper;
  private readonly token?: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client: any = null;
  private botUserId: string | null = null;
  private activeChats = new Set<string>();

  constructor(options: DiscordChannelOptions = {}) {
    this.mapper = options.mapper ?? new DiscordSessionMapper();
    this.token = options.token ?? process.env.DISCORD_BOT_TOKEN;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!DiscordLib) {
      this.logger?.error?.("discord: discord.js not installed; run `npm install discord.js`");
      return { stop: async () => undefined };
    }
    if (!this.token) {
      this.logger?.error?.("discord: DISCORD_BOT_TOKEN not set");
      return { stop: async () => undefined };
    }

    const { Client, GatewayIntentBits, Partials } = DiscordLib;

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message],
      });

      this.client.on("ready", (c: any) => {
        this.botUserId = c.user?.id ?? null;
        this.logger?.info?.(`discord: logged in as ${c.user?.tag ?? this.botUserId}`);
      });

      this.client.on("messageCreate", (message: any) => {
        void this.handleMessageCreate(message).catch((e) => {
          this.logger?.error?.(`discord: messageCreate error: ${e}`);
        });
      });

      this.client.on("error", (err: any) => {
        this.logger?.error?.(`discord: client error: ${err}`);
      });

      await this.client.login(this.token);
    } catch (e) {
      this.logger?.error?.(`discord: start failed: ${e}`);
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`discord: stopping (${reason ?? "no reason"})`);
        if (this.client) {
          try { this.client.destroy(); } catch { /* best effort */ }
          this.client = null;
        }
        this.botUserId = null;
      },
    };
  }

  private async handleMessageCreate(message: any): Promise<void> {
    if (!message?.author || message.author.bot) return;
    if (message.system) return;
    if (this.botUserId && message.author.id === this.botUserId) return;

    const text = String(message.content ?? "").trim();
    if (!text) return;

    const chatId = String(message.channel?.id ?? "");
    if (!chatId) return;

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`discord: chat ${chatId} already active, skipping`);
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

  private async processMessage(chatId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    void this.sendTyping(chatId);

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "discord",
        message,
      })) {
        const fragment = renderDiscordEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`discord: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.client) return;
    let channel: any;
    try {
      channel = await this.client.channels.fetch(chatId);
    } catch (e) {
      this.logger?.error?.(`discord: fetch channel failed: ${e}`);
      return;
    }
    if (!channel || typeof channel.send !== "function") {
      this.logger?.warn?.(`discord: channel ${chatId} not sendable`);
      return;
    }
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      try {
        await channel.send({ content: chunk });
      } catch (e) {
        this.logger?.error?.(`discord: send failed: ${e}`);
      }
    }
  }

  private async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && typeof channel.sendTyping === "function") {
        await channel.sendTyping();
      }
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
