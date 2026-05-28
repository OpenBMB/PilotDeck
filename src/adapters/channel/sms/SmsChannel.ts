import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { SmsSessionMapper } from "./SmsSessionMapper.js";
import { renderSmsEvent } from "./sms-render.js";

let twilioFactory: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  twilioFactory = require("twilio");
} catch {
  // twilio not installed — start() will warn
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;
const DEFAULT_PATH = "/sms/incoming";
const MAX_BODY_BYTES = 1_048_576;
const TWIML_OK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export type SmsChannelOptions = {
  extra?: Record<string, unknown>;
  mapper?: SmsSessionMapper;
};

export class SmsChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "sms";

  private readonly mapper: SmsSessionMapper;
  private readonly extra: Record<string, unknown>;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client: any = null;
  private server: Server | null = null;
  private accountSid = "";
  private authToken = "";
  private fromNumber = "";
  private publicUrl = "";
  private host = DEFAULT_HOST;
  private port = DEFAULT_PORT;
  private path = DEFAULT_PATH;
  private activeChats = new Set<string>();

  constructor(options: SmsChannelOptions = {}) {
    this.mapper = options.mapper ?? new SmsSessionMapper();
    this.extra = options.extra ?? {};
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!twilioFactory) {
      this.logger?.error?.("sms: twilio not installed; run `npm install twilio`");
      return { stop: async () => undefined };
    }

    this.accountSid = String(this.extra.accountSid ?? process.env.TWILIO_ACCOUNT_SID ?? "");
    this.authToken = String(
      this.extra.authToken ?? this.extra.apiKey ?? process.env.TWILIO_AUTH_TOKEN ?? this.extra.token ?? "",
    );
    this.fromNumber = String(this.extra.phoneNumber ?? process.env.TWILIO_PHONE_NUMBER ?? "");
    this.host = String(this.extra.webhookHost ?? DEFAULT_HOST);
    this.port = Number(this.extra.webhookPort ?? process.env.TWILIO_WEBHOOK_PORT ?? DEFAULT_PORT);
    this.path = String(this.extra.webhookPath ?? DEFAULT_PATH);
    this.publicUrl = String(this.extra.publicUrl ?? "");

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      this.logger?.error?.("sms: missing config; need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER");
      return { stop: async () => undefined };
    }

    try {
      this.client = twilioFactory(this.accountSid, this.authToken);
    } catch (e) {
      this.logger?.error?.(`sms: twilio init failed: ${e}`);
      return { stop: async () => undefined };
    }

    try {
      this.server = createServer((req, res) => {
        void this.handleHttp(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.port, this.host, () => {
          this.server!.off("error", reject);
          resolve();
        });
      });
      this.logger?.info?.(
        `sms: Twilio webhook http://${this.host}:${this.port}${this.path}` +
          (this.publicUrl ? ` (configure Twilio URL: ${this.publicUrl.replace(/\/$/, "")}${this.path})` : ""),
      );
    } catch (e) {
      this.logger?.error?.(`sms: HTTP server failed: ${e}`);
      this.server = null;
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`sms: stopping (${reason ?? "no reason"})`);
        if (this.server) {
          await new Promise<void>((resolve) => {
            this.server!.close(() => resolve());
          });
          this.server = null;
        }
        this.client = null;
      },
    };
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${this.host}:${this.port}`}`);
    if (url.pathname !== this.path || req.method !== "POST") {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readRequestBody(req, MAX_BODY_BYTES);
    } catch (e) {
      res.statusCode = 400;
      res.end(`Bad Request: ${e}`);
      return;
    }

    let params: Record<string, string>;
    try {
      const ct = String(req.headers["content-type"] ?? "");
      if (ct.includes("application/json")) {
        params = JSON.parse(bodyText) as Record<string, string>;
      } else {
        params = Object.fromEntries(new URLSearchParams(bodyText));
      }
    } catch {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }

    const sig = String(req.headers["x-twilio-signature"] ?? "");
    const fullUrl = this.publicUrl
      ? `${this.publicUrl.replace(/\/$/, "")}${this.path}`
      : `http://${this.host}:${this.port}${this.path}`;

    if (this.authToken && sig) {
      if (!this.validateTwilioSignature(fullUrl, params, sig)) {
        this.logger?.warn?.("sms: invalid Twilio signature");
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
    }

    const body = params.Body ?? "";
    const from = params.From ?? "";

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/xml");
    res.end(TWIML_OK);

    if (!from || !body.trim()) return;

    void this.handleIncoming(from, body).catch((e) =>
      this.logger?.error?.(`sms: handleIncoming error: ${e}`),
    );
  }

  private validateTwilioSignature(
    url: string,
    params: Record<string, string>,
    signature: string,
  ): boolean {
    const keys = Object.keys(params).sort();
    let data = url;
    for (const k of keys) {
      data += k + params[k];
    }
    const hmac = createHmac("sha1", this.authToken).update(data).digest("base64");
    try {
      const a = Buffer.from(hmac);
      const b = Buffer.from(signature);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private async handleIncoming(chatId: string, text: string): Promise<void> {
    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`sms: chat ${chatId} already active, skipping`);
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
        channelKey: "sms",
        message,
      })) {
        const fragment = renderSmsEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`sms: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.messages.create({
        body: text,
        from: this.fromNumber,
        to: chatId,
      });
    } catch (e) {
      this.logger?.error?.(`sms: sendMessage failed: ${e}`);
    }
  }
}

function readRequestBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
