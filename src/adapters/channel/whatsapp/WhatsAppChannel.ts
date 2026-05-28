import { spawn, type ChildProcess } from "node:child_process";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { WhatsAppSessionMapper } from "./WhatsAppSessionMapper.js";
import { renderWhatsAppEvent } from "./whatsapp-render.js";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:3100";
const POLL_MS = 2000;
const READY_TIMEOUT_MS = 15_000;

export type WhatsAppChannelOptions = {
  bridgePath?: string;
  bridgeUrl?: string;
  mapper?: WhatsAppSessionMapper;
};

type InboundMessage = {
  id: string;
  chatId: string;
  text: string;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export class WhatsAppChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "whatsapp";

  private readonly mapper: WhatsAppSessionMapper;
  private readonly bridgePath: string;
  private readonly bridgeUrl: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private child: ChildProcess | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollAbort = new AbortController();
  private seenIds = new Set<string>();
  private activeChats = new Set<string>();
  private running = false;

  constructor(options: WhatsAppChannelOptions = {}) {
    this.mapper = options.mapper ?? new WhatsAppSessionMapper();
    this.bridgePath = (options.bridgePath ?? process.env.WHATSAPP_BRIDGE_PATH ?? "").trim();
    this.bridgeUrl = normalizeBaseUrl(
      options.bridgeUrl ?? process.env.WHATSAPP_BRIDGE_URL ?? DEFAULT_BRIDGE_URL,
    );
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!this.bridgePath) {
      this.logger?.error?.("whatsapp: bridgePath / WHATSAPP_BRIDGE_PATH is required");
      return { stop: async () => undefined };
    }

    this.pollAbort = new AbortController();
    this.seenIds.clear();

    const bridgePort = this.extractPort(this.bridgeUrl);

    try {
      this.child = spawn(process.execPath, [this.bridgePath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(bridgePort != null ? { BRIDGE_PORT: String(bridgePort) } : {}),
        },
      });
      this.child.stderr?.on("data", (d: Buffer) => {
        this.logger?.warn?.(`whatsapp[bridge]: ${d.toString().trimEnd()}`);
      });
      this.child.on("error", (err) => {
        this.logger?.error?.(`whatsapp: bridge spawn error: ${err}`);
      });
      this.child.on("exit", (code, sig) => {
        if (this.running) {
          this.logger?.error?.(
            `whatsapp: bridge exited (code=${code}, signal=${sig ?? "none"})`,
          );
        }
      });

      const ready = await this.waitForBridgeReady(READY_TIMEOUT_MS);
      if (!ready) {
        await this.cleanupChild();
        this.logger?.error?.("whatsapp: bridge HTTP did not become ready");
        return { stop: async () => undefined };
      }

      this.running = true;
      this.pollTimer = setInterval(() => void this.pollOnce(), POLL_MS);
      void this.pollOnce();
      this.logger?.info?.(`whatsapp: connected, polling ${this.bridgeUrl}/messages`);
    } catch (e) {
      this.logger?.error?.(`whatsapp: start failed: ${e}`);
      await this.cleanupChild();
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`whatsapp: stopping (${reason ?? "no reason"})`);
        this.running = false;
        this.pollAbort.abort();
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        await this.cleanupChild();
      },
    };
  }

  private extractPort(url: string): number | null {
    try {
      const u = new URL(url);
      const p = Number(u.port);
      return Number.isFinite(p) && p > 0 ? p : null;
    } catch {
      return null;
    }
  }

  private async waitForBridgeReady(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${this.bridgeUrl}/messages`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok || res.status === 404) return true;
      } catch {
        // bridge still starting
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) return;
    try {
      const res = await fetch(`${this.bridgeUrl}/messages`, { signal: this.pollAbort.signal });
      if (!res.ok) {
        this.logger?.warn?.(`whatsapp: poll ${res.status} ${res.statusText}`);
        return;
      }
      const data = (await res.json()) as unknown;
      const list = this.normalizeMessages(data);
      for (const m of list) {
        if (this.seenIds.has(m.id)) continue;
        this.seenIds.add(m.id);
        void this.dispatch(m);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      this.logger?.error?.(`whatsapp: poll error: ${e}`);
    }
  }

  private normalizeMessages(data: unknown): InboundMessage[] {
    const out: InboundMessage[] = [];
    let raw: unknown[] = [];
    if (Array.isArray(data)) {
      raw = data;
    } else if (data && typeof data === "object") {
      const o = data as Record<string, unknown>;
      if (Array.isArray(o.messages)) raw = o.messages;
      else if (Array.isArray(o.data)) raw = o.data;
    }
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const id = String(o.id ?? o.key ?? o.messageId ?? "").trim();
      const chatId = String(o.chatId ?? o.chat_id ?? o.from ?? "").trim();
      const text = String(o.text ?? o.body ?? o.content ?? "").trim();
      if (!id || !chatId) continue;
      out.push({ id, chatId, text });
    }
    return out;
  }

  private async dispatch(msg: InboundMessage): Promise<void> {
    if (!msg.text) return;

    if (this.activeChats.has(msg.chatId)) {
      this.logger?.info?.(`whatsapp: chat ${msg.chatId} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId: msg.chatId, text: msg.text });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(msg.chatId, "已创建新会话。");
      return;
    }
    if (!mapped.message) return;

    this.activeChats.add(msg.chatId);
    try {
      await this.processMessage(msg.chatId, mapped.sessionKey, mapped.message);
    } finally {
      this.activeChats.delete(msg.chatId);
    }
  }

  private async processMessage(chatId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "whatsapp",
        message,
      })) {
        const fragment = renderWhatsAppEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`whatsapp: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.running) return;
    try {
      const res = await fetch(`${this.bridgeUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, message: text }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const raw: any = await res.json().catch(() => ({}));
        const err = raw?.error ?? res.statusText;
        this.logger?.error?.(`whatsapp: send HTTP ${res.status}: ${err}`);
      }
    } catch (e) {
      this.logger?.error?.(`whatsapp: send failed: ${e}`);
    }
  }

  private async cleanupChild(): Promise<void> {
    if (!this.child) return;
    const proc = this.child;
    this.child = null;
    try {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        }, 5000);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    } catch {
      // ignore
    }
  }
}
