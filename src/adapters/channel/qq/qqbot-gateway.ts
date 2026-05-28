import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * QQ Official Bot API Gateway client.
 * Connects via WebSocket to receive events, uses HTTP to send messages.
 * Docs: https://bot.q.qq.com/wiki/develop/api-v2/
 */

export type QQBotCredentials = {
  appId: string;
  clientSecret: string;
};

export type QQBotGatewayEvent = {
  op: number;
  s?: number;
  t?: string;
  d?: unknown;
};

export type QQGroupMessageEvent = {
  id: string;
  author: { member_openid: string };
  content: string;
  group_openid: string;
  timestamp: string;
};

export type QQC2CMessageEvent = {
  id: string;
  author: { user_openid: string };
  content: string;
  timestamp: string;
};

type AccessTokenInfo = {
  accessToken: string;
  expiresAt: number;
};

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const GATEWAY_URL = `${API_BASE}/gateway`;
const GROUP_INTENTS = 1 << 25; // GROUP_AND_C2C_EVENT

export class QQBotGateway extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly credentials: QQBotCredentials;
  private tokenInfo: AccessTokenInfo | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs = 41250;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(credentials: QQBotCredentials) {
    super();
    this.credentials = credentials;
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    await this.ensureAccessToken();

    const gatewayUrl = await this.getGatewayUrl();
    this.ws = new WebSocket(gatewayUrl);

    this.ws.on("open", () => {
      this.emit("connected");
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as QQBotGatewayEvent;
        this.handleGatewayMessage(msg);
      } catch { /* ignore malformed */ }
    });

    this.ws.on("close", (code) => {
      this.stopHeartbeat();
      if (!this.intentionalClose) {
        this.emit("disconnected", { code });
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      this.emit("error", err);
    });
  }

  close(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  async sendGroupMessage(groupOpenId: string, content: string, msgId?: string, msgSeq?: number): Promise<void> {
    await this.ensureAccessToken();
    const url = `${API_BASE}/v2/groups/${groupOpenId}/messages`;
    const body: Record<string, unknown> = {
      content,
      msg_type: 0,
    };
    if (msgId) {
      body.msg_id = msgId;
      body.msg_seq = msgSeq ?? 1;
    }
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `QQBot ${this.tokenInfo!.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`sendGroupMessage failed: ${resp.status} ${text}`);
    }
  }

  async sendC2CMessage(userOpenId: string, content: string, msgId?: string, msgSeq?: number): Promise<void> {
    await this.ensureAccessToken();
    const url = `${API_BASE}/v2/users/${userOpenId}/messages`;
    const body: Record<string, unknown> = {
      content,
      msg_type: 0,
    };
    if (msgId) {
      body.msg_id = msgId;
      body.msg_seq = msgSeq ?? 1;
    }
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `QQBot ${this.tokenInfo!.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`sendC2CMessage failed: ${resp.status} ${text}`);
    }
  }

  private handleGatewayMessage(msg: QQBotGatewayEvent): void {
    if (msg.s != null) {
      this.lastSeq = msg.s;
    }

    switch (msg.op) {
      case 10: // Hello
        this.heartbeatMs = (msg.d as { heartbeat_interval: number })?.heartbeat_interval ?? 41250;
        if (this.sessionId) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;

      case 0: // Dispatch
        this.handleDispatch(msg);
        break;

      case 11: // Heartbeat ACK
        break;

      case 7: // Reconnect
        this.ws?.close();
        break;

      case 9: // Invalid Session
        this.sessionId = null;
        this.lastSeq = null;
        setTimeout(() => this.sendIdentify(), 2000);
        break;
    }
  }

  private handleDispatch(msg: QQBotGatewayEvent): void {
    this.emit("raw_dispatch", { type: msg.t, data: msg.d });

    if (msg.t === "READY") {
      const data = msg.d as { session_id?: string };
      this.sessionId = data?.session_id ?? null;
      this.startHeartbeat();
      this.emit("ready", data);
      return;
    }

    if (msg.t === "RESUMED") {
      this.startHeartbeat();
      this.emit("resumed");
      return;
    }

    if (msg.t === "GROUP_AT_MESSAGE_CREATE") {
      this.emit("group_message", msg.d as QQGroupMessageEvent);
      return;
    }

    if (msg.t === "C2C_MESSAGE_CREATE") {
      this.emit("c2c_message", msg.d as QQC2CMessageEvent);
      return;
    }

    this.emit("dispatch", { type: msg.t, data: msg.d });
  }

  private sendIdentify(): void {
    if (!this.ws || !this.tokenInfo) return;
    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token: `QQBot ${this.tokenInfo.accessToken}`,
        intents: GROUP_INTENTS,
        shard: [0, 1],
        properties: {
          $os: "linux",
          $browser: "pilotdeck",
          $device: "pilotdeck",
        },
      },
    }));
  }

  private sendResume(): void {
    if (!this.ws || !this.tokenInfo) return;
    this.ws.send(JSON.stringify({
      op: 6,
      d: {
        token: `QQBot ${this.tokenInfo.accessToken}`,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    }));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.emit("reconnecting");
      void this.connect().catch((e) => this.emit("error", e));
    }, 5000);
  }

  private async ensureAccessToken(): Promise<void> {
    if (this.tokenInfo && Date.now() < this.tokenInfo.expiresAt - 120_000) {
      return;
    }
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: this.credentials.appId,
        clientSecret: this.credentials.clientSecret,
      }),
    });
    if (!resp.ok) {
      throw new Error(`getAppAccessToken failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json() as { access_token: string; expires_in: string };
    this.tokenInfo = {
      accessToken: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in) * 1000,
    };

    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    const refreshIn = (Number(data.expires_in) - 300) * 1000;
    this.tokenRefreshTimer = setTimeout(() => {
      void this.ensureAccessToken().catch(() => {});
    }, refreshIn);
  }

  private async getGatewayUrl(): Promise<string> {
    const resp = await fetch(GATEWAY_URL, {
      headers: { "Authorization": `QQBot ${this.tokenInfo!.accessToken}` },
    });
    if (!resp.ok) {
      throw new Error(`getGateway failed: ${resp.status}`);
    }
    const data = await resp.json() as { url: string };
    return data.url;
  }
}
