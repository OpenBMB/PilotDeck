import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { WebhookSessionMapper } from "./WebhookSessionMapper.js";
import { renderWebhookEvent } from "./webhook-render.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8643;
const DEFAULT_RATE_LIMIT = 30;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const INSECURE_NO_AUTH = "__INSECURE_NO_AUTH__";

export interface WebhookRoute {
  secret?: string;
  deliver?: string;
  description?: string;
  [key: string]: unknown;
}

export type WebhookChannelOptions = {
  port?: number;
  host?: string;
  secret?: string;
  routes?: Record<string, WebhookRoute>;
  rateLimit?: number;
  maxBodyBytes?: number;
  mapper?: WebhookSessionMapper;
};

export class WebhookChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "webhook";

  private readonly mapper: WebhookSessionMapper;
  private readonly host: string;
  private readonly port: number;
  private readonly globalSecret: string;
  private readonly routes: Record<string, WebhookRoute>;
  private readonly rateLimit: number;
  private readonly maxBodyBytes: number;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private server: Server | null = null;
  private deliveryInfo = new Map<string, Record<string, unknown>>();
  private deliveryInfoCreated = new Map<string, number>();
  private seenDeliveries = new Map<string, number>();
  private rateCounts = new Map<string, number[]>();
  private activeChats = new Set<string>();

  constructor(options: WebhookChannelOptions = {}) {
    this.mapper = options.mapper ?? new WebhookSessionMapper();
    this.host = options.host ?? DEFAULT_HOST;
    this.port = Number(options.port ?? DEFAULT_PORT);
    this.globalSecret = options.secret ?? "";
    this.routes = options.routes ?? {};
    this.rateLimit = Number(options.rateLimit ?? DEFAULT_RATE_LIMIT);
    this.maxBodyBytes = Number(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    for (const [name, route] of Object.entries(this.routes)) {
      const secret = route.secret || this.globalSecret;
      if (!secret) {
        this.logger?.error?.(
          `webhook: route '${name}' has no HMAC secret. Set 'secret' on the route or globally. ` +
            `For testing without auth, set secret to '${INSECURE_NO_AUTH}'.`,
        );
        return { stop: async () => undefined };
      }
    }

    try {
      this.server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.port, this.host, () => {
          this.server!.off("error", reject);
          resolve();
        });
      });
      const routeNames = Object.keys(this.routes).join(", ") || "(none configured)";
      this.logger?.info?.(`webhook: listening on http://${this.host}:${this.port} — routes: ${routeNames}`);
    } catch (e) {
      this.logger?.error?.(`webhook: failed to start: ${e}`);
      this.server = null;
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`webhook: stopping (${reason ?? "no reason"})`);
        if (this.server) {
          await new Promise<void>((resolve) => {
            this.server!.close(() => resolve());
          });
          this.server = null;
        }
      },
    };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${this.host}:${this.port}`}`);

    if (url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", platform: "webhook" });
      return;
    }

    const match = url.pathname.match(/^\/webhooks\/([^/]+)$/);
    if (match && req.method === "POST") {
      await this.handleWebhook(req, res, match[1]);
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  }

  private async handleWebhook(req: IncomingMessage, res: ServerResponse, routeName: string): Promise<void> {
    const route = this.routes[routeName];
    if (!route) {
      sendJson(res, 404, { error: `Unknown route: ${routeName}` });
      return;
    }

    const now = Date.now() / 1000;
    if (!this.checkRateLimit(routeName, now)) {
      sendJson(res, 429, { error: "Rate limit exceeded" });
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readRequestBody(req, this.maxBodyBytes);
    } catch (e) {
      sendJson(res, 413, { error: `Request too large or unreadable: ${e}` });
      return;
    }

    const secret = route.secret || this.globalSecret;
    if (secret !== INSECURE_NO_AUTH) {
      const signature = String(
        req.headers["x-hub-signature-256"] ?? req.headers["x-signature-256"] ?? "",
      );
      if (!this.verifyHmac(bodyText, secret, signature)) {
        sendJson(res, 401, { error: "Invalid signature" });
        return;
      }
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      body = { raw: bodyText };
    }

    const deliveryId = String(
      req.headers["x-delivery-id"] ??
        req.headers["x-github-delivery"] ??
        `${routeName}-${now}`,
    );
    if (this.seenDeliveries.has(deliveryId)) {
      sendJson(res, 200, { status: "duplicate", delivery_id: deliveryId });
      return;
    }
    this.seenDeliveries.set(deliveryId, now);
    this.pruneSeenDeliveries(now);

    const text = this.extractText(body);
    if (!text) {
      sendJson(res, 200, { status: "ignored", reason: "no text content" });
      return;
    }

    const chatId = `webhook:${routeName}:${deliveryId}`;
    this.deliveryInfo.set(chatId, {
      deliver: route.deliver ?? "log",
      route: routeName,
      ...body,
    });
    this.deliveryInfoCreated.set(chatId, now);
    this.pruneDeliveryInfo(now);

    sendJson(res, 200, { status: "accepted", delivery_id: deliveryId });

    void this.handleIncoming(chatId, text).catch((e) =>
      this.logger?.error?.(`webhook: handleIncoming error: ${e}`),
    );
  }

  private async handleIncoming(chatId: string, text: string): Promise<void> {
    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`webhook: chat ${chatId} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.deliverReply(chatId, "已创建新会话。");
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
        channelKey: "webhook",
        message,
      })) {
        const fragment = renderWebhookEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`webhook: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.deliverReply(chatId, finalText);
    }
  }

  private async deliverReply(chatId: string, text: string): Promise<void> {
    const delivery = this.deliveryInfo.get(chatId);
    const deliverType = (delivery?.deliver as string | undefined) ?? "log";

    if (deliverType === "log") {
      this.logger?.info?.(`webhook: response for ${chatId}: ${text.slice(0, 200)}`);
      return;
    }

    this.logger?.info?.(`webhook: deliver type '${deliverType}' for ${chatId}: ${text.slice(0, 100)}`);
  }

  private verifyHmac(body: string, secret: string, signature: string): boolean {
    if (!signature) return false;
    const sig = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  }

  private extractText(body: Record<string, unknown>): string | null {
    if (typeof body.text === "string") return body.text;
    if (typeof body.message === "string") return body.message;
    if (typeof body.content === "string") return body.content;
    if (typeof body.body === "string") return body.body;

    if (body.action && body.issue && typeof (body.issue as any).body === "string") {
      return `GitHub ${body.action}: ${(body.issue as any).title}\n${(body.issue as any).body}`;
    }
    if (body.action && body.pull_request) {
      const pr = body.pull_request as Record<string, unknown>;
      return `GitHub PR ${body.action}: ${pr.title}\n${pr.body ?? ""}`;
    }
    if (body.comment && typeof (body.comment as any).body === "string") {
      return `Comment: ${(body.comment as any).body}`;
    }

    const str = JSON.stringify(body);
    if (str.length > 5 && str !== "{}") return str;

    return null;
  }

  private checkRateLimit(routeName: string, now: number): boolean {
    const window = 60;
    let timestamps = this.rateCounts.get(routeName) ?? [];
    timestamps = timestamps.filter((t) => t > now - window);
    if (timestamps.length >= this.rateLimit) return false;
    timestamps.push(now);
    this.rateCounts.set(routeName, timestamps);
    return true;
  }

  private pruneSeenDeliveries(now: number): void {
    const cutoff = now - 3600;
    for (const [k, t] of this.seenDeliveries) {
      if (t < cutoff) this.seenDeliveries.delete(k);
    }
  }

  private pruneDeliveryInfo(now: number): void {
    const cutoff = now - 3600;
    for (const [k, t] of this.deliveryInfoCreated) {
      if (t < cutoff) {
        this.deliveryInfo.delete(k);
        this.deliveryInfoCreated.delete(k);
      }
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
