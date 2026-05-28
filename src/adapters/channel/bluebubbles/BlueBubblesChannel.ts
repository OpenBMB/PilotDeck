import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { BlueBubblesSessionMapper } from "./BlueBubblesSessionMapper.js";
import { renderBlueBubblesEvent } from "./bluebubbles-render.js";

const POLL_MS = 2500;
const MESSAGE_LIMIT = 50;

export type BlueBubblesChannelOptions = {
  serverUrl?: string;
  password?: string;
  mapper?: BlueBubblesSessionMapper;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class BlueBubblesChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "bluebubbles";

  private readonly mapper: BlueBubblesSessionMapper;
  private readonly serverUrl: string;
  private readonly password: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollAbort = new AbortController();
  private lastTimestamp = 0;
  private seenGuids = new Set<string>();
  private activeChats = new Set<string>();
  private running = false;

  constructor(options: BlueBubblesChannelOptions = {}) {
    this.mapper = options.mapper ?? new BlueBubblesSessionMapper();
    this.serverUrl = normalizeBaseUrl(
      options.serverUrl ?? process.env.BLUEBUBBLES_SERVER_URL ?? "",
    );
    this.password = options.password ?? process.env.BLUEBUBBLES_PASSWORD ?? "";
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!this.serverUrl || !this.password) {
      this.logger?.error?.(
        "bluebubbles: serverUrl and password (or BLUEBUBBLES_SERVER_URL / BLUEBUBBLES_PASSWORD) are required",
      );
      return { stop: async () => undefined };
    }

    this.pollAbort = new AbortController();
    this.seenGuids.clear();
    this.lastTimestamp = Math.floor(Date.now() / 1000) - 5;
    this.running = true;

    this.pollTimer = setInterval(() => void this.pollMessages(), POLL_MS);
    void this.pollMessages();
    this.logger?.info?.(`bluebubbles: polling ${this.serverUrl}/api/v1/message`);

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`bluebubbles: stopping (${reason ?? "no reason"})`);
        this.running = false;
        this.pollAbort.abort();
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
      },
    };
  }

  private async pollMessages(): Promise<void> {
    if (!this.running) return;
    const base = new URL("/api/v1/message", this.serverUrl);
    base.searchParams.set("password", this.password);
    base.searchParams.set("after", String(this.lastTimestamp));
    base.searchParams.set("limit", String(MESSAGE_LIMIT));

    try {
      const res = await fetch(base.toString(), { signal: this.pollAbort.signal });
      if (!res.ok) {
        this.logger?.warn?.(`bluebubbles: poll ${res.status}`);
        return;
      }
      const data = (await res.json()) as any;
      const rows: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.messages)
            ? data.messages
            : [];

      let maxTs = this.lastTimestamp;
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const o = row as Record<string, unknown>;
        const guid = String(o.guid ?? o.id ?? "");
        if (guid && this.seenGuids.has(guid)) continue;
        if (guid) this.seenGuids.add(guid);

        const ts = num(o.dateCreated ?? o.timestamp ?? o.time);
        if (ts != null && ts > maxTs) maxTs = ts;

        await this.dispatchPayload(o);
      }
      if (maxTs > this.lastTimestamp) this.lastTimestamp = maxTs;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      this.logger?.error?.(`bluebubbles: poll error: ${e}`);
    }
  }

  private async dispatchPayload(o: Record<string, unknown>): Promise<void> {
    const isFromMe = Boolean(o.isFromMe ?? o.is_from_me);
    if (isFromMe) return;

    const text = String(o.text ?? o.body ?? o.message ?? "").trim();
    const chatsField = o.chats as any;
    const chatGuid = String(
      o.chatGuid ?? o.chat_guid ?? (Array.isArray(chatsField) ? chatsField[0] : "") ?? "",
    );
    if (!chatGuid || !text) return;

    if (this.activeChats.has(chatGuid)) {
      this.logger?.info?.(`bluebubbles: chat ${chatGuid} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId: chatGuid, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(chatGuid, "已创建新会话。");
      return;
    }
    if (!mapped.message) return;

    this.activeChats.add(chatGuid);
    try {
      await this.processMessage(chatGuid, mapped.sessionKey, mapped.message);
    } finally {
      this.activeChats.delete(chatGuid);
    }
  }

  private async processMessage(chatGuid: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "bluebubbles",
        message,
      })) {
        const fragment = renderBlueBubblesEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`bluebubbles: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatGuid, finalText);
    }
  }

  private async sendReply(chatGuid: string, text: string): Promise<void> {
    if (!this.running) return;
    const url = new URL("/api/v1/message/text", this.serverUrl);
    const tempGuid = randomUUID();
    const body: Record<string, unknown> = {
      chatGuid,
      message: text,
      tempGuid,
      password: this.password,
    };
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.password}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const raw: any = await res.json().catch(() => ({}));
        const err = raw?.message ?? raw?.error ?? res.statusText;
        this.logger?.error?.(`bluebubbles: send HTTP ${res.status}: ${err}`);
      }
    } catch (e) {
      this.logger?.error?.(`bluebubbles: send failed: ${e}`);
    }
  }
}
