import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { SignalSessionMapper } from "./SignalSessionMapper.js";
import { renderSignalEvent } from "./signal-render.js";

const MAX_MESSAGE_LENGTH = 2000;
const DEFAULT_REST_URL = "http://127.0.0.1:8080";

export type SignalChannelOptions = {
  restUrl?: string;
  account?: string;
  mapper?: SignalSessionMapper;
};

type EnvelopeExtract = {
  text: string;
  sourceNumber?: string;
  sourceUuid?: string;
  messageId?: string;
  chatId?: string;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function extractTextFromEnvelope(raw: Record<string, unknown>): EnvelopeExtract {
  const envelope = raw.envelope as Record<string, unknown> | undefined;
  if (!envelope) return { text: "" };

  const sync = envelope.syncMessage as Record<string, unknown> | undefined;
  const sent = sync?.sentMessage as Record<string, unknown> | undefined;
  const dm = envelope.dataMessage as Record<string, unknown> | undefined;
  const msg =
    (typeof sent?.message === "string" && sent.message) ||
    (typeof dm?.message === "string" && dm.message) ||
    "";

  const source =
    (typeof envelope.source === "string" && envelope.source) ||
    (typeof envelope.sourceNumber === "string" && envelope.sourceNumber) ||
    undefined;
  const sourceUuid =
    typeof envelope.sourceUuid === "string" ? envelope.sourceUuid : undefined;

  const ts =
    (typeof dm?.timestamp === "number" && String(dm.timestamp)) ||
    (typeof sent?.timestamp === "number" && String(sent.timestamp)) ||
    undefined;

  const groupId =
    (dm?.groupInfo as Record<string, unknown> | undefined)?.groupId ??
    (sent?.groupInfo as Record<string, unknown> | undefined)?.groupId;
  const chatId =
    typeof groupId === "string" ? `group:${groupId}` : source ? `dm:${source}` : undefined;

  return { text: msg, sourceNumber: source, sourceUuid, messageId: ts, chatId };
}

export class SignalChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "signal";

  private readonly mapper: SignalSessionMapper;
  private readonly restUrl: string;
  private readonly account: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private abort: AbortController | null = null;
  private receivePromise: Promise<void> | null = null;
  private running = false;
  private activeChats = new Set<string>();
  private recipientByChat = new Map<string, string>();

  constructor(options: SignalChannelOptions = {}) {
    this.mapper = options.mapper ?? new SignalSessionMapper();
    this.restUrl = normalizeBaseUrl(
      options.restUrl ?? process.env.SIGNAL_HTTP_URL ?? DEFAULT_REST_URL,
    );
    this.account = options.account ?? process.env.SIGNAL_ACCOUNT ?? "";
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!this.account) {
      this.logger?.error?.("signal: SIGNAL_ACCOUNT / account not set");
      return { stop: async () => undefined };
    }

    this.abort = new AbortController();
    this.running = true;
    this.receivePromise = this.runReceiveLoop(this.abort.signal);
    this.logger?.info?.(
      `signal: SSE receive at ${this.restUrl}/v1/receive/${encodeURIComponent(this.account)}`,
    );

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`signal: stopping (${reason ?? "no reason"})`);
        this.running = false;
        this.abort?.abort();
        this.abort = null;
        if (this.receivePromise) {
          try { await this.receivePromise; } catch { /* best effort */ }
          this.receivePromise = null;
        }
      },
    };
  }

  private async runReceiveLoop(signal: AbortSignal): Promise<void> {
    const url = `${this.restUrl}/v1/receive/${encodeURIComponent(this.account)}`;
    let carry = "";

    while (!signal.aborted && this.running) {
      try {
        const res = await fetch(url, {
          signal,
          headers: { Accept: "text/event-stream, application/json, */*" },
        });
        if (!res.ok) {
          this.logger?.error?.(
            `signal: receive HTTP ${res.status}: ${await res.text().catch(() => "")}`,
          );
          await this.sleepBackoff(signal);
          continue;
        }
        if (!res.body) {
          await this.sleepBackoff(signal);
          continue;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          carry += dec.decode(value, { stream: true });
          const lines = carry.split(/\r?\n/);
          carry = lines.pop() ?? "";
          for (const line of lines) {
            await this.parseLine(line);
          }
        }
      } catch (e) {
        if (signal.aborted) break;
        this.logger?.error?.(`signal: receive stream error: ${e}`);
        await this.sleepBackoff(signal);
      }
    }
  }

  private async parseLine(line: string): Promise<void> {
    let payload = line.trim();
    if (!payload) return;
    if (payload.startsWith("data:")) payload = payload.slice(5).trim();
    if (payload === "[DONE]" || payload === ":ok") return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }

    const { text, sourceNumber, chatId } = extractTextFromEnvelope(data);
    if (!text.trim()) return;

    const sessionChatId = chatId ?? (sourceNumber ? `dm:${sourceNumber}` : this.account);
    const recipient = sourceNumber ?? sessionChatId.replace(/^(dm:|group:)/, "");
    if (recipient) this.recipientByChat.set(sessionChatId, recipient);

    if (this.activeChats.has(sessionChatId)) {
      this.logger?.info?.(`signal: chat ${sessionChatId} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId: sessionChatId, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(sessionChatId, "已创建新会话。");
      return;
    }
    if (!mapped.message) return;

    this.activeChats.add(sessionChatId);
    try {
      await this.processMessage(sessionChatId, mapped.sessionKey, mapped.message);
    } finally {
      this.activeChats.delete(sessionChatId);
    }
  }

  private async processMessage(chatId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "signal",
        message,
      })) {
        const fragment = renderSignalEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`signal: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.running) return;
    const recipient =
      this.recipientByChat.get(chatId) ?? chatId.replace(/^(dm:|group:)/, "");
    if (!recipient) {
      this.logger?.warn?.(`signal: no recipient for ${chatId}, cannot send`);
      return;
    }
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      const body = {
        message: chunk,
        number: this.account,
        recipients: [recipient],
      };
      try {
        const res = await fetch(`${this.restUrl}/v2/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const raw = await res.text().catch(() => "");
          this.logger?.error?.(`signal: send HTTP ${res.status}: ${raw.slice(0, 500)}`);
        }
      } catch (e) {
        this.logger?.error?.(`signal: send failed: ${e}`);
      }
    }
  }

  private async sleepBackoff(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 3000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
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
