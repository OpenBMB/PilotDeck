import * as http from "node:http";
import * as crypto from "node:crypto";
import { URL } from "node:url";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { WeComCallbackSessionMapper } from "./WeComCallbackSessionMapper.js";
import { renderWeComCallbackEvent } from "./wecom-callback-render.js";

const QYAPI = "https://qyapi.weixin.qq.com/cgi-bin";
const DEFAULT_PORT = 8780;
const TOKEN_TTL_MS = 7000 * 1000;
const MAX_MESSAGE_LENGTH = 2048;

function sha1Hex(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function verifyMsgSignature(token: string, timestamp: string, nonce: string, msgEncrypt: string, sig: string): boolean {
  const sorted = [token, timestamp, nonce, msgEncrypt].sort().join("");
  return sha1Hex(sorted) === sig;
}

function decryptWxMessage(encodingAesKeyB43: string, ciphertextB64: string, expectCorpId?: string): string {
  const key = Buffer.from(encodingAesKeyB43 + "=", "base64");
  if (key.length !== 32) throw new Error("encodingAesKey must decode to 32 bytes");
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  let raw = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  const pad = raw[raw.length - 1];
  if (pad > 32 || pad < 1) throw new Error("invalid PKCS#7 padding");
  raw = raw.subarray(0, raw.length - pad);
  const content = raw.subarray(16);
  const xmlLen = content.readUInt32BE(0);
  const tail = content.subarray(4 + xmlLen).toString("utf8");
  if (expectCorpId && tail && tail !== expectCorpId) {
    throw new Error("corpId mismatch after decrypt");
  }
  return content.subarray(4, 4 + xmlLen).toString("utf8");
}

function xmlTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? "").trim();
}

function extractEncryptFromXml(xml: string): string | undefined {
  const cdata = xml.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/i)?.[1]?.trim();
  if (cdata) return cdata;
  return xml.match(/<Encrypt>([^<]+)<\/Encrypt>/i)?.[1]?.trim();
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export type WeComCallbackChannelOptions = {
  corpId?: string;
  agentId?: string;
  secret?: string;
  token?: string;
  encodingAesKey?: string;
  port?: number;
  mapper?: WeComCallbackSessionMapper;
};

export class WeComCallbackChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "wecom_callback";

  private readonly mapper: WeComCallbackSessionMapper;
  private readonly corpId: string;
  private readonly callbackToken: string;
  private readonly encodingAesKey: string;
  private readonly corpSecret: string;
  private readonly agentId: string;
  private readonly port: number;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private server: http.Server | null = null;
  private accessToken: string | null = null;
  private accessTokenExpires = 0;
  private activeChats = new Set<string>();

  constructor(options: WeComCallbackChannelOptions = {}) {
    this.mapper = options.mapper ?? new WeComCallbackSessionMapper();
    this.corpId = String(options.corpId ?? process.env.WECOM_CORP_ID ?? "").trim();
    this.agentId = String(options.agentId ?? process.env.WECOM_AGENT_ID ?? "").trim();
    this.corpSecret = String(options.secret ?? process.env.WECOM_CB_SECRET ?? "").trim();
    this.callbackToken = String(options.token ?? process.env.WECOM_CB_TOKEN ?? "").trim();
    this.encodingAesKey = String(options.encodingAesKey ?? process.env.WECOM_ENCODING_AES_KEY ?? "").trim();
    const p = Number(options.port ?? process.env.WECOM_CB_PORT ?? DEFAULT_PORT);
    this.port = Number.isFinite(p) && p > 0 ? Math.floor(p) : DEFAULT_PORT;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!this.corpId || !this.callbackToken || !this.encodingAesKey) {
      this.logger?.error?.("wecom_callback: corpId, token, and encodingAesKey are required");
      return { stop: async () => undefined };
    }
    if (!this.corpSecret || !this.agentId) {
      this.logger?.error?.("wecom_callback: secret and agentId are required for outbound send");
      return { stop: async () => undefined };
    }

    try {
      this.server = http.createServer((req, res) => void this.onHttp(req, res));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.port, "0.0.0.0", () => resolve());
      });
      this.logger?.info?.(`wecom_callback: listening on 0.0.0.0:${this.port}`);
    } catch (e) {
      this.logger?.error?.(`wecom_callback: start failed: ${e}`);
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`wecom_callback: stopping (${reason ?? "no reason"})`);
        if (this.server) {
          await new Promise<void>((resolve) => {
            this.server!.close(() => resolve());
          });
          this.server = null;
        }
      },
    };
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const q = url.searchParams;

      if (req.method === "GET") {
        const msgSig = q.get("msg_signature") ?? "";
        const timestamp = q.get("timestamp") ?? "";
        const nonce = q.get("nonce") ?? "";
        const echostr = q.get("echostr") ?? "";
        if (!echostr) {
          res.writeHead(400).end("missing echostr");
          return;
        }
        if (!verifyMsgSignature(this.callbackToken, timestamp, nonce, echostr, msgSig)) {
          res.writeHead(403).end("signature");
          return;
        }
        const plain = decryptWxMessage(this.encodingAesKey, echostr, this.corpId);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(plain);
        return;
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        const msgSig = q.get("msg_signature") ?? "";
        const timestamp = q.get("timestamp") ?? "";
        const nonce = q.get("nonce") ?? "";
        const encryptNode = extractEncryptFromXml(body);
        if (!encryptNode) {
          res.writeHead(400).end("no Encrypt");
          return;
        }
        if (!verifyMsgSignature(this.callbackToken, timestamp, nonce, encryptNode, msgSig)) {
          res.writeHead(403).end("signature");
          return;
        }
        const innerXml = decryptWxMessage(this.encodingAesKey, encryptNode, this.corpId);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("success");

        void this.dispatchInboundXml(innerXml);
        return;
      }

      res.writeHead(405).end();
    } catch (e) {
      this.logger?.error?.(`wecom_callback: HTTP error: ${e}`);
      try {
        res.writeHead(500).end("error");
      } catch { /* ignore */ }
    }
  }

  private async dispatchInboundXml(xml: string): Promise<void> {
    const msgType = xmlTag(xml, "MsgType") ?? "text";
    const from = xmlTag(xml, "FromUserName") ?? "";
    if (!from) return;
    if (msgType !== "text") return;
    const text = xmlTag(xml, "Content") ?? "";
    if (!text.trim()) return;

    const chatId = from;

    if (this.activeChats.has(chatId)) {
      this.logger?.info?.(`wecom_callback: chat ${chatId} already active, skipping`);
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
        channelKey: "wecom_callback",
        message,
      })) {
        const fragment = renderWeComCallbackEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`wecom_callback: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(chatId, finalText);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const url = `${QYAPI}/message/send?access_token=${encodeURIComponent(token)}`;
      const body = {
        touser: chatId,
        msgtype: "text",
        agentid: Number(this.agentId),
        text: { content: text.slice(0, MAX_MESSAGE_LENGTH) },
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const raw = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
      const errcode = raw.errcode;
      if (!res.ok || (errcode != null && errcode !== 0)) {
        const err = raw.errmsg ?? res.statusText;
        this.logger?.error?.(`wecom_callback: sendReply failed (errcode=${errcode}): ${err}`);
        if (errcode === 40014 || errcode === 42001) {
          this.accessToken = null;
        }
      }
    } catch (e) {
      this.logger?.error?.(`wecom_callback: sendReply error: ${e}`);
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpires) return this.accessToken;

    const url = `${QYAPI}/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.corpSecret)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };
    if (!res.ok || (data.errcode != null && data.errcode !== 0)) {
      throw new Error(data.errmsg ?? `gettoken failed (${res.status})`);
    }
    if (!data.access_token) throw new Error("gettoken: no access_token");
    this.accessToken = data.access_token;
    const sec = typeof data.expires_in === "number" ? data.expires_in : 7200;
    this.accessTokenExpires = Date.now() + Math.min(sec * 1000 - 60_000, TOKEN_TTL_MS);
    return this.accessToken;
  }
}
