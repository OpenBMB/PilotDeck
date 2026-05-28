import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { SlackSessionMapper } from "./SlackSessionMapper.js";
import { renderSlackEvent } from "./slack-render.js";

let BoltApp: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BoltApp = require("@slack/bolt").App;
} catch {
  // @slack/bolt not installed — start() will warn
}

const MAX_MESSAGE_LENGTH = 39000;

export type SlackChannelOptions = {
  botToken?: string;
  appToken?: string;
  mapper?: SlackSessionMapper;
};

export class SlackChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "slack";

  private readonly mapper: SlackSessionMapper;
  private readonly botToken?: string;
  private readonly appToken?: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private app: any = null;
  private botUserId: string | null = null;
  private activeChats = new Set<string>();

  constructor(options: SlackChannelOptions = {}) {
    this.mapper = options.mapper ?? new SlackSessionMapper();
    this.botToken = options.botToken ?? process.env.SLACK_BOT_TOKEN;
    this.appToken = options.appToken ?? process.env.SLACK_APP_TOKEN;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!BoltApp) {
      this.logger?.error?.("slack: @slack/bolt not installed; run `npm install @slack/bolt`");
      return { stop: async () => undefined };
    }
    if (!this.botToken) {
      this.logger?.error?.("slack: SLACK_BOT_TOKEN not set");
      return { stop: async () => undefined };
    }
    if (!this.appToken) {
      this.logger?.error?.("slack: SLACK_APP_TOKEN not set (required for Socket Mode)");
      return { stop: async () => undefined };
    }

    try {
      this.app = new BoltApp({
        token: this.botToken,
        appToken: this.appToken,
        socketMode: true,
      });

      this.app.event("message", async ({ event }: any) => {
        try {
          await this.handleSlackMessage(event);
        } catch (e) {
          this.logger?.error?.(`slack: message handler error: ${e}`);
        }
      });

      this.app.error(async (err: any) => {
        this.logger?.error?.(`slack: bolt error: ${err}`);
      });

      await this.app.start();
      const auth = await this.app.client.auth.test({ token: this.botToken });
      this.botUserId = (auth.user_id as string) ?? null;
      this.logger?.info?.(`slack: Socket Mode connected as ${auth.user ?? auth.user_id}`);
    } catch (e) {
      this.logger?.error?.(`slack: start failed: ${e}`);
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`slack: stopping (${reason ?? "no reason"})`);
        if (this.app) {
          try { await this.app.stop(); } catch { /* best effort */ }
          this.app = null;
        }
        this.botUserId = null;
      },
    };
  }

  private async handleSlackMessage(event: any): Promise<void> {
    if (!event) return;
    if (event.bot_id || event.subtype === "bot_message") return;
    if (event.subtype === "message_changed" || event.subtype === "message_deleted") return;

    const userId = event.user as string | undefined;
    if (userId && this.botUserId && userId === this.botUserId) return;

    const channelId = event.channel as string | undefined;
    if (!channelId) return;

    const text = String(event.text ?? "").replace(/<@[^>]+>/g, "").trim();
    const threadTs = (event.thread_ts as string | undefined) ?? undefined;
    const ts = event.ts as string | undefined;

    // Conversation key includes the thread root when present so each Slack thread
    // gets its own session bucket (DMs and channel parents share their own).
    const chatId = threadTs && threadTs !== ts ? `${channelId}:${threadTs}` : channelId;

    if (!text) return;

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`slack: chat ${chatId} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId, text });
    const sendCtx = { channelId, threadTs };

    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(sendCtx, "已创建新会话。");
      return;
    }
    if (!mapped.message) return;

    this.activeChats.add(chatId);
    try {
      await this.processMessage(sendCtx, mapped.sessionKey, mapped.message);
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private async processMessage(
    ctx: { channelId: string; threadTs?: string },
    sessionKey: string,
    message: string,
  ): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "slack",
        message,
      })) {
        const fragment = renderSlackEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`slack: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(ctx, finalText);
    }
  }

  private async sendReply(
    ctx: { channelId: string; threadTs?: string },
    text: string,
  ): Promise<void> {
    if (!this.app) return;
    const formatted = formatSlackMrkdwn(text);
    const chunks = chunkText(formatted, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      try {
        await this.app.client.chat.postMessage({
          channel: ctx.channelId,
          text: chunk,
          mrkdwn: true,
          ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
        });
      } catch (e) {
        this.logger?.error?.(`slack: postMessage failed: ${e}`);
      }
    }
  }
}

function formatSlackMrkdwn(content: string): string {
  if (!content) return content;
  let t = content;
  t = t.replace(/\*\*(.+?)\*\*/g, "*$1*");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  return t;
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
