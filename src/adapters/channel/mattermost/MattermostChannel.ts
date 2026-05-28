import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { MattermostSessionMapper } from "./MattermostSessionMapper.js";
import { renderMattermostEvent } from "./mattermost-render.js";

let WebSocketImpl: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wsMod = require("ws");
  WebSocketImpl = wsMod.WebSocket ?? wsMod;
} catch {
  WebSocketImpl = (globalThis as any).WebSocket;
}

const MAX_MESSAGE_LENGTH = 16383;
const RECONNECT_DELAY_MS = 4000;

export type MattermostChannelOptions = {
  token?: string;
  serverUrl?: string;
  teamId?: string;
  mapper?: MattermostSessionMapper;
};

export class MattermostChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "mattermost";

  private readonly mapper: MattermostSessionMapper;
  private readonly token: string;
  private readonly serverUrl: string;
  private readonly teamId?: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private apiBase = "";
  private ws: any = null;
  private botUserId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private activeChats = new Set<string>();

  constructor(options: MattermostChannelOptions = {}) {
    this.mapper = options.mapper ?? new MattermostSessionMapper();
    this.token = options.token ?? process.env.MATTERMOST_TOKEN ?? "";
    this.serverUrl = options.serverUrl ?? process.env.MATTERMOST_URL ?? "";
    this.teamId = options.teamId ?? process.env.MATTERMOST_TEAM_ID;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!this.serverUrl || !this.token) {
      this.logger?.error?.("mattermost: serverUrl and token are required (MATTERMOST_URL, MATTERMOST_TOKEN)");
      return { stop: async () => undefined };
    }
    if (!WebSocketImpl) {
      this.logger?.error?.("mattermost: WebSocket implementation unavailable; run `npm install ws`");
      return { stop: async () => undefined };
    }

    this.apiBase = this.serverUrl.replace(/\/$/, "");

    try {
      const me = (await this.rest("GET", "/users/me")) as { id?: string };
      this.botUserId = me.id ?? null;
    } catch (e) {
      this.logger?.error?.(`mattermost: token check failed: ${e}`);
      return { stop: async () => undefined };
    }

    this.closed = false;
    const { wsBase, origin } = toWsBase(this.serverUrl);
    this.openWebSocket(wsBase, origin);
    this.logger?.info?.(
      `mattermost: connected (REST=${this.apiBase}${this.teamId ? `, team=${this.teamId}` : ""})`,
    );

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`mattermost: stopping (${reason ?? "no reason"})`);
        this.closed = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.ws) {
          try { this.ws.close(); } catch { /* best effort */ }
          this.ws = null;
        }
        this.botUserId = null;
      },
    };
  }

  private openWebSocket(wsBase: string, origin: string): void {
    const url = `${wsBase}/api/v4/websocket?token=${encodeURIComponent(this.token)}`;

    try {
      const ws = new WebSocketImpl(url, { headers: { Origin: origin } });
      this.ws = ws;

      const onMsg = (data: string | Buffer) => void this.onWsMessage(String(data));
      const onErr = (e: unknown) => this.logger?.error?.(`mattermost: ws error: ${e}`);
      const onClose = () => {
        this.ws = null;
        if (!this.closed) {
          this.reconnectTimer = setTimeout(() => this.openWebSocket(wsBase, origin), RECONNECT_DELAY_MS);
        }
      };

      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("message", (ev: any) => onMsg(ev?.data ?? ""));
        ws.addEventListener("error", onErr);
        ws.addEventListener("close", onClose);
      } else {
        ws.on("message", onMsg);
        ws.on("error", onErr);
        ws.on("close", onClose);
      }
    } catch (e) {
      this.logger?.error?.(`mattermost: ws connect failed: ${e}`);
    }
  }

  private async onWsMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if ((msg.event as string | undefined) !== "posted") return;

    const dataStr = (msg.data as Record<string, unknown> | undefined)?.post as string | undefined;
    if (!dataStr) return;

    let post: Record<string, unknown>;
    try {
      post = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      return;
    }

    const userId = post.user_id as string | undefined;
    if (userId && this.botUserId && userId === this.botUserId) return;

    const props = post.props as Record<string, unknown> | undefined;
    if (props?.from_webhook === "true" || props?.from_bot === "true") return;

    const channelId = post.channel_id as string | undefined;
    const rootId = (post.root_id as string) || undefined;
    const text = String(post.message ?? "").replace(/\r\n/g, "\n").trim();

    if (!channelId || !text) return;

    // Treat each thread as its own session bucket (channel root vs thread reply).
    const chatId = rootId ? `${channelId}:${rootId}` : channelId;

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`mattermost: chat ${chatId} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId, text });
    const sendCtx = { channelId, rootId };

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
    ctx: { channelId: string; rootId?: string },
    sessionKey: string,
    message: string,
  ): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "mattermost",
        message,
      })) {
        const fragment = renderMattermostEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`mattermost: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(ctx, finalText);
    }
  }

  private async sendReply(
    ctx: { channelId: string; rootId?: string },
    text: string,
  ): Promise<void> {
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      try {
        await this.rest("POST", "/posts", {
          channel_id: ctx.channelId,
          message: chunk,
          root_id: ctx.rootId || undefined,
        });
      } catch (e) {
        this.logger?.error?.(`mattermost: post failed: ${e}`);
      }
    }
  }

  private async rest(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}

function toWsBase(url: string): { wsBase: string; origin: string } {
  const u = new URL(url.startsWith("http") ? url : `https://${url}`);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  const path = u.pathname.replace(/\/$/, "");
  const wsBase = `${proto}//${u.host}${path}`;
  const origin = `${u.protocol === "https:" ? "https:" : "http:"}//${u.host}`;
  return { wsBase, origin };
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
