import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { EmailSessionMapper } from "./EmailSessionMapper.js";
import { renderEmailEvent } from "./email-render.js";

let ImapFlow: any;
let nodemailer: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ImapFlow = require("imapflow").ImapFlow;
} catch {
  // imapflow not installed — start() will warn
}
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nodemailer = require("nodemailer");
} catch {
  // nodemailer not installed — start() will warn
}

const DEFAULT_POLL_INTERVAL_MS = 45_000;

export type EmailChannelOptions = {
  extra?: Record<string, unknown>;
  mapper?: EmailSessionMapper;
};

export class EmailChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "email";

  private readonly mapper: EmailSessionMapper;
  private readonly extra: Record<string, unknown>;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private imapClient: any = null;
  private transporter: any = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private seenUids = new Set<number>();
  private ownAddress = "";
  private defaultSubject = "Message";
  private activeChats = new Set<string>();
  private stopped = false;

  constructor(options: EmailChannelOptions = {}) {
    this.mapper = options.mapper ?? new EmailSessionMapper();
    this.extra = options.extra ?? {};
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;
    this.stopped = false;

    if (!ImapFlow || !nodemailer) {
      this.logger?.error?.("email: imapflow and/or nodemailer not installed; run `npm install imapflow nodemailer`");
      return { stop: async () => undefined };
    }

    this.ownAddress = String(this.extra.address ?? process.env.EMAIL_ADDRESS ?? "");
    const password = String(this.extra.password ?? process.env.EMAIL_PASSWORD ?? "");
    const imapHost = String(this.extra.imapHost ?? process.env.IMAP_HOST ?? "");
    const smtpHost = String(this.extra.smtpHost ?? process.env.SMTP_HOST ?? "");
    const imapPort = Number(this.extra.imapPort ?? process.env.IMAP_PORT ?? 993);
    const smtpPort = Number(this.extra.smtpPort ?? process.env.SMTP_PORT ?? 587);
    const pollIntervalMs = Number(this.extra.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const imapTls = this.extra.imapTls !== false;
    const smtpTls = this.extra.smtpTls !== false;
    this.defaultSubject = String(this.extra.defaultSubject ?? "Message");

    if (!this.ownAddress || !password || !imapHost || !smtpHost) {
      this.logger?.error?.("email: missing config; need extra.address, password, imapHost, smtpHost (or env equivalents)");
      return { stop: async () => undefined };
    }

    try {
      this.imapClient = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: imapTls,
        auth: { user: this.ownAddress, pass: password },
        logger: false,
      });

      await this.imapClient.connect();
      await this.imapClient.mailboxOpen("INBOX");

      try {
        const st = await this.imapClient.status("INBOX", { uidNext: true });
        const next = st.uidNext ?? 1;
        if (next > 1) {
          const from = Math.max(1, next - 300);
          for await (const msg of this.imapClient.fetch(`${from}:${next - 1}`, { uid: true })) {
            this.seenUids.add(msg.uid as number);
          }
        }
      } catch (e) {
        this.logger?.warn?.(`email: UID priming skipped: ${e}`);
      }

      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        requireTLS: smtpTls && smtpPort !== 465,
        auth: { user: this.ownAddress, pass: password },
      });
      await this.transporter.verify();

      await this.pollOnce();
      this.pollTimer = setInterval(() => {
        void this.pollOnce();
      }, pollIntervalMs);

      this.logger?.info?.(`email: IMAP+SMTP connected (${imapHost} / ${smtpHost})`);
    } catch (e) {
      this.logger?.error?.(`email: connect failed: ${e}`);
      await this.cleanupImap();
      this.transporter = null;
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`email: stopping (${reason ?? "no reason"})`);
        this.stopped = true;
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.transporter = null;
        await this.cleanupImap();
      },
    };
  }

  private async cleanupImap(): Promise<void> {
    if (this.imapClient) {
      try { await this.imapClient.logout(); } catch { /* best effort */ }
      this.imapClient = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.imapClient || this.stopped) return;
    let lock: any;
    try {
      lock = await this.imapClient.getMailboxLock("INBOX");
    } catch (e) {
      this.logger?.error?.(`email: failed to acquire mailbox lock: ${e}`);
      return;
    }
    try {
      for await (const msg of this.imapClient.fetch(
        { unseen: true },
        { envelope: true, source: true, uid: true },
      )) {
        const uid = msg.uid as number;
        if (this.seenUids.has(uid)) continue;
        this.seenUids.add(uid);

        const env = msg.envelope as Record<string, unknown> | undefined;
        const from = env?.from as Array<{ address?: string }> | undefined;
        const replyAddr = from?.[0]?.address ?? "unknown";

        let text = "";
        try {
          const raw =
            msg.source instanceof Buffer
              ? msg.source.toString("utf8")
              : String((msg as { source?: Buffer }).source ?? "");
          text = this.extractPlainText(raw);
        } catch {
          text = "[Could not decode message body]";
        }

        if (!text.trim()) continue;

        void this.handleIncoming(replyAddr, text);
      }
    } catch (e) {
      this.logger?.error?.(`email: poll error: ${e}`);
    } finally {
      try { lock?.release?.(); } catch { /* best effort */ }
    }
  }

  private extractPlainText(raw: string): string {
    if (!raw.includes("Content-Type:")) {
      return raw.trim();
    }
    const plain = raw.match(/Content-Type:\s*text\/plain[^\r\n]*[\r\n]+([\s\S]*?)(?=--[a-f0-9]{8,}|Content-Type:|$)/i);
    if (plain?.[1]) {
      let body = plain[1].replace(/^\r?\n/, "");
      const te = body.match(/^Content-Transfer-Encoding:\s*quoted-printable\r?\n([\s\S]*)/i);
      if (te) {
        body = te[1].replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        );
      }
      return body.trim();
    }
    return raw.slice(0, 8000).trim();
  }

  private async handleIncoming(chatId: string, text: string): Promise<void> {
    if (!chatId || chatId === "unknown") return;

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`email: chat ${chatId} already active, skipping`);
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
        channelKey: "email",
        message,
      })) {
        const fragment = renderEmailEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`email: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.transporter) return;
    try {
      await this.transporter.sendMail({
        from: this.ownAddress,
        to: chatId,
        subject: this.defaultSubject,
        text,
      });
    } catch (e) {
      this.logger?.error?.(`email: sendMail failed: ${e}`);
    }
  }
}
