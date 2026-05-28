import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ILinkClient, loginWithQR, MessageItemType } from "weixin-ilink";
import type { WeixinMessage, LoginResult } from "weixin-ilink";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { WeixinSessionMapper } from "./WeixinSessionMapper.js";
import { renderWeixinEvent } from "./weixin-render.js";

const CREDENTIALS_PATH = join(homedir(), ".pilotdeck", "weixin-credentials.json");

export type WeixinChannelOptions = {
  credentialsPath?: string;
  mapper?: WeixinSessionMapper;
};

type SavedCredentials = {
  baseUrl: string;
  botToken: string;
  accountId: string;
  cursor?: string;
};

export class WeixinChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "weixin";

  private readonly credentialsPath: string;
  private readonly mapper: WeixinSessionMapper;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client?: ILinkClient;
  private loopAbort = new AbortController();
  private pollPromise: Promise<void> | null = null;
  private activeChats = new Set<string>();
  private contextTokens = new Map<string, string>();

  constructor(options: WeixinChannelOptions = {}) {
    this.credentialsPath = options.credentialsPath ?? CREDENTIALS_PATH;
    this.mapper = options.mapper ?? new WeixinSessionMapper();
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    const creds = await this.ensureLoggedIn();
    if (!creds) {
      return { stop: async () => undefined };
    }

    this.client = new ILinkClient({
      baseUrl: creds.baseUrl,
      token: creds.botToken,
    });

    if (creds.cursor) {
      this.client.cursor = creds.cursor;
    }

    this.loopAbort = new AbortController();
    this.pollPromise = this.pollLoop();
    this.logger?.info?.("weixin: connected, poll loop started");

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`weixin: stopping (${reason ?? "no reason"})`);
        this.loopAbort.abort();
        this.saveCursor();
        try { await this.pollPromise; } catch { /* ignore */ }
        this.pollPromise = null;
      },
    };
  }

  private async ensureLoggedIn(): Promise<SavedCredentials | null> {
    const saved = this.loadCredentials();
    if (saved) {
      this.logger?.info?.(`weixin: loaded saved credentials (account: ${saved.accountId})`);
      return saved;
    }

    this.logger?.info?.("weixin: no credentials found, starting QR login...");
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║  微信 iLink 登录 — 请用微信扫描二维码        ║");
    console.log("╚══════════════════════════════════════════════╝\n");

    try {
      const result: LoginResult = await loginWithQR({
        onQRCode: (url) => {
          console.log(`[weixin] 扫码登录链接:\n${url}\n`);
        },
        onStatusChange: (status) => {
          const labels: Record<string, string> = {
            waiting: "等待扫码...",
            scanned: "已扫码，等待确认...",
            expired: "二维码已过期，正在刷新...",
            refreshing: "刷新中...",
          };
          console.log(`[weixin] ${labels[status] ?? status}`);
        },
      });

      const creds: SavedCredentials = {
        baseUrl: result.baseUrl,
        botToken: result.botToken,
        accountId: result.accountId,
      };
      this.saveCredentials(creds);
      console.log(`[weixin] 登录成功! accountId: ${result.accountId}\n`);
      this.logger?.info?.(`weixin: login successful, accountId=${result.accountId}`);
      return creds;
    } catch (e) {
      this.logger?.error?.(`weixin: QR login failed: ${e}`);
      console.error(`[weixin] 登录失败: ${e}`);
      return null;
    }
  }

  private async pollLoop(): Promise<void> {
    if (!this.client) return;

    while (!this.loopAbort.signal.aborted) {
      try {
        const resp = await this.client.poll();

        if (resp.errcode === -14) {
          this.logger?.error?.("weixin: session expired (errcode -14), need re-login");
          console.error("[weixin] Session 过期，请删除凭证文件并重启以重新扫码登录:");
          console.error(`[weixin]   rm ${this.credentialsPath}`);
          break;
        }

        if (resp.ret !== 0 && resp.ret !== undefined) {
          this.logger?.warn?.(`weixin: poll ret=${resp.ret} errmsg=${resp.errmsg}`);
          await this.sleep(3000);
          continue;
        }

        for (const msg of resp.msgs ?? []) {
          if (msg.message_type === 1) {
            void this.dispatchMessage(msg);
          }
        }

        this.saveCursor();
      } catch (e) {
        if (this.loopAbort.signal.aborted) break;
        this.logger?.error?.(`weixin: poll error: ${e}`);
        await this.sleep(3000);
      }
    }
  }

  private async dispatchMessage(msg: WeixinMessage): Promise<void> {
    const fromUser = msg.from_user_id ?? "";
    if (!fromUser) return;

    if (msg.context_token) {
      this.contextTokens.set(fromUser, msg.context_token);
    }

    const textItem = msg.item_list?.find((i) => i.type === MessageItemType.TEXT);
    const text = textItem?.text_item?.text ?? "";

    if (!text.trim()) return;

    if (this.activeChats.has(fromUser)) {
      this.logger?.info?.(`weixin: chat ${fromUser} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId: fromUser, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(fromUser, "已创建新会话。");
      return;
    }

    if (!mapped.message) return;

    this.activeChats.add(fromUser);
    try {
      await this.processMessage(fromUser, mapped.sessionKey, mapped.message);
    } finally {
      this.activeChats.delete(fromUser);
    }
  }

  private async processMessage(
    userId: string,
    sessionKey: string,
    message: string,
  ): Promise<void> {
    if (!this.gateway) return;

    await this.sendTypingIfPossible(userId);

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "weixin",
        message,
      })) {
        const fragment = renderWeixinEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`weixin: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(userId, finalText);
    }
  }

  private async sendReply(userId: string, text: string): Promise<void> {
    if (!this.client) return;
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) {
      this.logger?.warn?.(`weixin: no context_token for ${userId}, cannot send`);
      return;
    }
    try {
      await this.client.sendTextChunked(userId, text, contextToken, 2000);
    } catch (e) {
      this.logger?.error?.(`weixin: sendText failed: ${e}`);
    }
  }

  private async sendTypingIfPossible(userId: string): Promise<void> {
    if (!this.client) return;
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return;
    try {
      await this.client.sendTyping(userId, contextToken);
    } catch { /* best effort */ }
  }

  private loadCredentials(): SavedCredentials | null {
    try {
      if (!existsSync(this.credentialsPath)) return null;
      const raw = readFileSync(this.credentialsPath, "utf-8");
      const data = JSON.parse(raw) as Partial<SavedCredentials>;
      if (!data.baseUrl || !data.botToken || !data.accountId) return null;
      return data as SavedCredentials;
    } catch {
      return null;
    }
  }

  private saveCredentials(creds: SavedCredentials): void {
    try {
      const dir = join(homedir(), ".pilotdeck");
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), "utf-8");
    } catch (e) {
      this.logger?.error?.(`weixin: failed to save credentials: ${e}`);
    }
  }

  private saveCursor(): void {
    if (!this.client) return;
    const creds = this.loadCredentials();
    if (creds) {
      creds.cursor = this.client.cursor;
      this.saveCredentials(creds);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.loopAbort.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
