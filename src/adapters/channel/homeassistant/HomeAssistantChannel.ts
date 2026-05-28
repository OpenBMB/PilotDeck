import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { HomeAssistantSessionMapper } from "./HomeAssistantSessionMapper.js";
import { renderHomeAssistantEvent } from "./homeassistant-render.js";

let WebSocketImpl: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wsMod = require("ws");
  WebSocketImpl = wsMod.WebSocket ?? wsMod;
} catch {
  WebSocketImpl = (globalThis as any).WebSocket;
}

const DEFAULT_URL = "http://127.0.0.1:8123";

export type HomeAssistantChannelOptions = {
  url?: string;
  token?: string;
  watchPrefixes?: string[];
  notificationTitle?: string;
  mapper?: HomeAssistantSessionMapper;
};

function httpToWs(base: string): string {
  const u = new URL(base.startsWith("http") ? base : `http://${base}`);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  const path = u.pathname.replace(/\/$/, "");
  return `${proto}//${u.host}${path}/api/websocket`;
}

export class HomeAssistantChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "homeassistant";

  private readonly mapper: HomeAssistantSessionMapper;
  private readonly url: string;
  private readonly token?: string;
  private readonly watchPrefixes: string[];
  private readonly notificationTitle?: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private ws: any = null;
  private idCounter = 1;
  private closed = false;
  private wsSessionReady = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authSettle: ((ok: boolean) => void) | null = null;
  private activeChats = new Set<string>();

  constructor(options: HomeAssistantChannelOptions = {}) {
    this.mapper = options.mapper ?? new HomeAssistantSessionMapper();
    this.url = options.url ?? process.env.HASS_URL ?? DEFAULT_URL;
    this.token = options.token ?? process.env.HASS_TOKEN;
    this.watchPrefixes = options.watchPrefixes?.length ? options.watchPrefixes : ["conversation."];
    this.notificationTitle = options.notificationTitle;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!this.token) {
      this.logger?.error?.("homeassistant: HASS_TOKEN not set");
      return { stop: async () => undefined };
    }
    if (!WebSocketImpl) {
      this.logger?.error?.("homeassistant: WebSocket unavailable; run `npm install ws`");
      return { stop: async () => undefined };
    }

    this.closed = false;
    this.wsSessionReady = false;

    const authOk = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const t = setTimeout(() => finish(false), 20_000);
      this.authSettle = (ok) => {
        clearTimeout(t);
        finish(ok);
      };
      this.openSocket();
    });
    this.authSettle = null;

    if (!authOk) {
      this.logger?.error?.("homeassistant: WebSocket auth failed or timed out");
      await this.cleanupWs();
      return { stop: async () => undefined };
    }

    this.logger?.info?.(`homeassistant: WebSocket ${httpToWs(this.url)}`);

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`homeassistant: stopping (${reason ?? "no reason"})`);
        this.closed = true;
        this.wsSessionReady = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        await this.cleanupWs();
      },
    };
  }

  private openSocket(): void {
    const wsUrl = httpToWs(this.url);
    try {
      const ws = new WebSocketImpl(wsUrl);
      this.ws = ws;

      const onMessage = (data: string | Buffer) => {
        void this.onRawMessage(String(data));
      };
      const onClose = () => {
        this.ws = null;
        this.authSettle?.(false);
        if (this.wsSessionReady && !this.closed) {
          this.reconnectTimer = setTimeout(() => this.openSocket(), 5000);
        }
      };
      const onError = (e: unknown) => this.logger?.error?.(`homeassistant: ws error: ${e}`);

      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("message", (ev: any) => onMessage(ev.data as string));
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
      } else {
        ws.on("message", onMessage);
        ws.on("close", onClose);
        ws.on("error", onError);
      }
    } catch (e) {
      this.logger?.error?.(`homeassistant: connect failed: ${e}`);
      this.authSettle?.(false);
    }
  }

  private async cleanupWs(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { /* best effort */ }
      this.ws = null;
    }
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(obj));
  }

  private nextId(): number {
    return this.idCounter++;
  }

  private async onRawMessage(raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg.type as string | undefined;

    if (type === "auth_required") {
      this.sendJson({ type: "auth", access_token: this.token });
      return;
    }

    if (type === "auth_ok") {
      const sid = this.nextId();
      this.sendJson({
        id: sid,
        type: "subscribe_events",
        event_type: "state_changed",
      });
      this.wsSessionReady = true;
      this.authSettle?.(true);
      this.authSettle = null;
      return;
    }

    if (type === "auth_invalid") {
      this.authSettle?.(false);
      this.authSettle = null;
      this.logger?.error?.(`homeassistant: auth invalid: ${msg.message ?? "invalid token"}`);
      return;
    }

    if (type === "event") {
      await this.handleHaEvent(msg);
    }
  }

  private async handleHaEvent(msg: Record<string, unknown>): Promise<void> {
    const ev = msg.event as Record<string, unknown> | undefined;
    if (!ev) return;

    if ((ev.event_type as string | undefined) !== "state_changed") return;

    const data = ev.data as Record<string, unknown> | undefined;
    const entityId = data?.entity_id as string | undefined;
    if (!entityId || !this.watchPrefixes.some((p) => entityId.startsWith(p))) return;

    const newState = (data?.new_state as Record<string, unknown> | undefined)?.state;
    const oldState = (data?.old_state as Record<string, unknown> | undefined)?.state;
    if (newState === oldState) return;
    const text = typeof newState === "string" ? newState : JSON.stringify(newState);

    if (!text || !text.trim()) return;

    void this.handleIncoming(entityId, text);
  }

  private async handleIncoming(chatId: string, text: string): Promise<void> {
    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`homeassistant: chat ${chatId} already active, skipping`);
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

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "homeassistant",
        message,
      })) {
        const fragment = renderHomeAssistantEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`homeassistant: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== 1) {
      this.logger?.warn?.(`homeassistant: not connected, cannot send to ${chatId}`);
      return;
    }
    const title = this.notificationTitle ?? `Gateway · ${chatId}`;
    this.sendJson({
      id: this.nextId(),
      type: "call_service",
      domain: "persistent_notification",
      service: "create",
      service_data: {
        title,
        message: text,
        notification_id: `gw_${Date.now()}`,
      },
    });
  }
}
