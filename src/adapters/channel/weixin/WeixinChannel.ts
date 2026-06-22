import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ILinkClient, loginWithQR, MessageItemType } from "weixin-ilink";
import type { ClientOptions, GetUpdatesResp, WeixinMessage, LoginResult } from "weixin-ilink";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { executeChannelCommand } from "../protocol/ChannelCommandRegistry.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import {
  ImLiveReplyController,
  type ImLiveReplyControllerOptions,
  type ImLiveReplyTransport,
} from "../protocol/ImLiveReplyController.js";
import { WeixinSessionMapper } from "./WeixinSessionMapper.js";

const CREDENTIALS_PATH = join(homedir(), ".pilotdeck", "weixin-credentials.json");
const POLL_RETRY_DELAY_MS = 3000;
let ilinkFetchCompatibilityInstalled = false;

export type WeixinChannelOptions = {
  credentialsPath?: string;
  mapper?: WeixinSessionMapper;
  liveReplyOptions?: Omit<ImLiveReplyControllerOptions<void>, "transport" | "onTransportError">;
  clientFactory?: (options: ClientOptions) => WeixinIlinkClient;
  loginWithQR?: typeof loginWithQR;
};

type SavedCredentials = {
  baseUrl: string;
  botToken: string;
  accountId: string;
  cursor?: string;
};

export type WeixinIlinkClient = {
  cursor: string;
  poll(): Promise<GetUpdatesResp>;
  sendTextChunked(toUserId: string, text: string, contextToken: string, maxLength?: number): Promise<number>;
  sendTyping(userId: string, contextToken?: string): Promise<void>;
};

export class WeixinChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "weixin";

  private readonly credentialsPath: string;
  private readonly mapper: WeixinSessionMapper;
  private readonly liveReplyOptions?: WeixinChannelOptions["liveReplyOptions"];
  private readonly clientFactory: (options: ClientOptions) => WeixinIlinkClient;
  private readonly login: typeof loginWithQR;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client?: WeixinIlinkClient;
  private loopAbort = new AbortController();
  private pollPromise: Promise<void> | null = null;
  private activeChats = new Set<string>();
  private readonly elicitation = new ImElicitationHelper();
  private contextTokens = new Map<string, string>();
  private consecutivePollErrors = 0;

  constructor(options: WeixinChannelOptions = {}) {
    this.credentialsPath = options.credentialsPath ?? CREDENTIALS_PATH;
    this.mapper = options.mapper ?? new WeixinSessionMapper();
    this.liveReplyOptions = options.liveReplyOptions;
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new ILinkClient(clientOptions));
    this.login = options.loginWithQR ?? loginWithQR;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    const creds = await this.ensureLoggedIn();
    if (!creds) {
      return { stop: async () => undefined };
    }

    installIlinkFetchCompatibility();
    this.client = this.createClient(creds);

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
      const result: LoginResult = await this.login({
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
        if (this.consecutivePollErrors > 0) {
          this.logger?.info?.(`weixin: poll recovered after ${this.consecutivePollErrors} error(s)`);
          this.consecutivePollErrors = 0;
        }

        if (resp.errcode === -14) {
          this.logger?.error?.("weixin: session expired (errcode -14), need re-login");
          console.error("[weixin] Session 过期，请删除凭证文件并重启以重新扫码登录:");
          console.error(`[weixin]   rm ${this.credentialsPath}`);
          break;
        }

        if (resp.ret !== 0 && resp.ret !== undefined) {
          this.logger?.warn?.(`weixin: poll ret=${resp.ret} errmsg=${resp.errmsg}`);
          await this.sleep(POLL_RETRY_DELAY_MS);
          continue;
        }

        const messages = resp.msgs ?? [];
        if (messages.length > 0) {
          this.logger?.info?.(`weixin: polled ${messages.length} message(s)`);
        }

        for (const msg of messages) {
          if (msg.message_type === 1) {
            void this.dispatchMessage(msg);
          }
        }

        this.saveCursor();
      } catch (e) {
        if (this.loopAbort.signal.aborted) break;
        this.consecutivePollErrors++;
        this.logger?.error?.(
          `weixin: poll error #${this.consecutivePollErrors}: ${formatWeixinError(e)}`,
        );
        this.rebuildClientAfterPollError(e);
        await this.sleep(POLL_RETRY_DELAY_MS);
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
    this.logger?.info?.(`weixin: received text message from ${fromUser}`);

    if (this.elicitation.hasPending(fromUser) && this.gateway) {
      try {
        const confirmation = await this.elicitation.answer(fromUser, text, this.gateway);
        if (confirmation) await this.sendReply(fromUser, confirmation);
      } catch (e) {
        this.logger?.error?.(`weixin: elicitation answer error: ${e}`);
      }
      return;
    }

    const mapped = this.mapper.resolve({ chatId: fromUser, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(fromUser, "已创建新会话。");
      return;
    }

    if (this.gateway && text.trim().startsWith("/")) {
      const handled = await executeChannelCommand(text, {
        gateway: this.gateway,
        chatId: fromUser,
        channelKey: "weixin",
        reply: (msg) => this.sendReply(fromUser, msg),
        bindProject: (projectKey) => this.mapper.bindProject(fromUser, projectKey),
        getProject: () => this.mapper.getProject(fromUser),
        logger: this.logger as any,
      });
      if (handled) return;
    }

    if (!mapped.message) return;

    if (this.activeChats.has(fromUser)) {
      this.logger?.info?.(`weixin: chat ${fromUser} already active, skipping`);
      return;
    }

    this.activeChats.add(fromUser);
    try {
      await this.processMessage(fromUser, mapped.sessionKey, mapped.message, mapped.projectKey);
    } finally {
      this.activeChats.delete(fromUser);
    }
  }

  private async processMessage(
    userId: string,
    sessionKey: string,
    message: string,
    projectKey?: string,
  ): Promise<void> {
    if (!this.gateway) return;

    const liveReply = new ImLiveReplyController<void>({
      ...this.liveReplyOptions,
      transport: this.createLiveReplyTransport(userId),
      onTransportError: (error, phase) => {
        this.logger?.warn?.(`weixin: live reply ${phase} failed: ${formatWeixinError(error)}`);
      },
    });
    const turnTimeoutMs = this.liveReplyOptions?.turnTimeoutMs ?? 600_000;
    let activeRunId: string | undefined;
    let watchdogSettled = false;
    const watchdog = turnTimeoutMs > 0
      ? setTimeout(() => {
          if (watchdogSettled) return;
          watchdogSettled = true;
          this.logger?.warn?.(`weixin: live reply timed out for user ${userId}`);
          void liveReply.markTimedOut().catch((error: unknown) => {
            this.logger?.warn?.(`weixin: mark timeout failed: ${formatWeixinError(error)}`);
          });
          void this.gateway?.abortTurn({ sessionKey, ...(activeRunId ? { runId: activeRunId } : {}) })
            .catch((error: unknown) => {
              this.logger?.warn?.(`weixin: abort timeout turn failed: ${formatWeixinError(error)}`);
            });
        }, turnTimeoutMs)
      : undefined;
    watchdog?.unref?.();

    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "weixin",
        message,
        allowPlanModeTools: false,
        timeoutMs: turnTimeoutMs,
        ...(projectKey ? { projectKey } : {}),
      })) {
        if (event.type === "turn_started") {
          activeRunId = event.runId;
        }
        if (event.type === "elicitation_request") {
          const questionText = this.elicitation.capture(userId, sessionKey, event);
          await liveReply.pauseActivity();
          await this.sendReply(userId, questionText);
          continue;
        }
        if (event.type === "error" && event.code === "agent_aborted") {
          await liveReply.markAborted();
          continue;
        }
        if (event.type === "error" && event.code === "turn_timeout") {
          await liveReply.markTimedOut();
          continue;
        }
        await liveReply.handleEvent(event);
      }
    } catch (e) {
      this.logger?.error?.(`weixin: submitTurn error: ${formatWeixinError(e)}`);
      await liveReply.handleEvent({
        type: "error",
        message: "处理消息时发生错误，请重试。",
        recoverable: true,
      });
    } finally {
      watchdogSettled = true;
      if (watchdog) clearTimeout(watchdog);
    }

    this.elicitation.clear(userId);
    await liveReply.flushFinal();
  }

  private createLiveReplyTransport(userId: string): ImLiveReplyTransport<void> {
    return {
      send: async (text) => {
        await this.sendReply(userId, text);
        return undefined;
      },
      pulseActivity: async () => {
        await this.sendTypingIfPossible(userId);
        return true;
      },
      stopActivity: async () => true,
    };
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
      this.logger?.info?.(`weixin: sent reply to ${userId}`);
    } catch (e) {
      this.logger?.error?.(`weixin: sendText failed: ${formatWeixinError(e)}`);
    }
  }

  private async sendTypingIfPossible(userId: string): Promise<void> {
    if (!this.client) return;
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return;
    try {
      await this.client.sendTyping(userId, contextToken);
    } catch (e) {
      this.logger?.warn?.(`weixin: sendTyping failed: ${formatWeixinError(e)}`);
    }
  }

  private createClient(creds: SavedCredentials, cursor = creds.cursor): WeixinIlinkClient {
    const client = this.clientFactory({
      baseUrl: creds.baseUrl,
      token: creds.botToken,
    });
    if (cursor) {
      client.cursor = cursor;
    }
    return client;
  }

  private rebuildClientAfterPollError(error: unknown): void {
    if (!isRecoverablePollError(error)) return;
    const creds = this.loadCredentials();
    if (!creds) {
      this.logger?.warn?.("weixin: cannot rebuild iLink client because credentials are missing");
      return;
    }

    const cursor = this.client?.cursor || creds.cursor;
    this.client = this.createClient(creds, cursor);
    if (cursor && creds.cursor !== cursor) {
      creds.cursor = cursor;
      this.saveCredentials(creds);
    }
    this.logger?.warn?.("weixin: rebuilt iLink client after recoverable poll error");
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

function isRecoverablePollError(error: unknown): boolean {
  const detail = formatWeixinError(error).toLowerCase();
  return (
    detail.includes("fetch failed") ||
    detail.includes("econnreset") ||
    detail.includes("enet") ||
    detail.includes("etimedout") ||
    detail.includes("und_err") ||
    detail.includes("socket") ||
    detail.includes("network") ||
    detail.includes("timeout")
  );
}

function formatWeixinError(error: unknown, depth = 0): string {
  if (error instanceof Error) {
    const pieces = [`${error.name}: ${error.message}`];
    const code = readStringProperty(error, "code");
    if (code) pieces.push(`code=${code}`);
    const cause = (error as { cause?: unknown }).cause;
    if (cause && depth < 2) {
      pieces.push(`cause=(${formatWeixinError(cause, depth + 1)})`);
    }
    if (depth === 0) {
      const stackLine = error.stack?.split("\n").slice(1, 2).map((line) => line.trim()).find(Boolean);
      if (stackLine) pieces.push(`at=${stackLine}`);
    }
    return pieces.join("; ");
  }

  if (typeof error === "object" && error !== null) {
    const name = readStringProperty(error, "name");
    const message = readStringProperty(error, "message");
    const code = readStringProperty(error, "code");
    const pieces = [name, message].filter(Boolean);
    if (code) pieces.push(`code=${code}`);
    if (pieces.length > 0) return pieces.join("; ");
  }

  return String(error);
}

function readStringProperty(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function installIlinkFetchCompatibility(): void {
  if (ilinkFetchCompatibilityInstalled) return;
  ilinkFetchCompatibilityInstalled = true;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    if (!url.includes("/ilink/bot/") || !init?.headers) {
      return originalFetch(input, init);
    }

    const headers = stripContentLengthHeader(init.headers);
    return originalFetch(input, { ...init, headers });
  }) as typeof fetch;
}

function stripContentLengthHeader(headers: HeadersInit): HeadersInit {
  if (headers instanceof Headers) {
    const next = new Headers(headers);
    next.delete("content-length");
    next.delete("Content-Length");
    return next;
  }

  if (Array.isArray(headers)) {
    return headers.filter(([key]) => key.toLowerCase() !== "content-length");
  }

  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "content-length") {
      next[key] = value;
    }
  }
  return next;
}
