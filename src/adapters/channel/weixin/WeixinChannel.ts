import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ILinkClient, loginWithQR, MessageItemType } from "weixin-ilink";
import type { ClientOptions, GetUpdatesResp, WeixinMessage, LoginResult } from "weixin-ilink";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { ChannelAttachment, Gateway, GatewayChannelKey, GatewayOutboundAttachment } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { executeChannelCommand } from "../protocol/ChannelCommandRegistry.js";
import {
  formatImAttachmentFallback,
  guessMimeTypeFromName,
  ImAttachmentDelivery,
  type PreparedImAttachment,
} from "../protocol/ImAttachmentDelivery.js";
import { ImAttachmentStore } from "../protocol/ImAttachmentStore.js";
import { ImChatSessionState } from "../protocol/ImChatSessionState.js";
import { deliverChatCronResult } from "../protocol/ImCronDelivery.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import {
  ImLiveReplyController,
  type ImLiveReplyControllerOptions,
  type ImLiveReplyTransport,
} from "../protocol/ImLiveReplyController.js";
import { WeixinSessionMapper, type WeixinSessionMapperState } from "./WeixinSessionMapper.js";
import { createVisibleErrorStatusDetail } from "../../../status/agentStatus.js";

const CREDENTIALS_PATH = join(homedir(), ".pilotdeck", "weixin-credentials.json");
const POLL_RETRY_DELAY_MS = 3000;
const WEIXIN_ACTIVITY_DELAY_MS = 10 * 60 * 1000;
const WEIXIN_ACTIVITY_UPDATE_THROTTLE_MS = 10 * 60 * 1000;
const WEIXIN_DEFAULT_TURN_TIMEOUT_MS = 0;
const WEIXIN_TIMEOUT_FINAL_TEXT = "处理时间已超过上限，任务已停止。你可以调整需求后重新发送。";
const WEIXIN_ACTIVITY_TTL_MS = Number.MAX_SAFE_INTEGER;
const WEIXIN_ACTIVITY_MAX_UPDATES = Number.MAX_SAFE_INTEGER;
const WEIXIN_CONNECTION_LOST_TEXT = "微信连接暂时中断，正在尝试恢复。当前任务仍会继续处理，恢复后我会继续回复。";
const WEIXIN_CONNECTION_RECOVERED_TEXT = "微信连接已恢复，我会继续处理当前任务。";
const WEIXIN_CONNECTION_RECOVERED_AFTER_LOSS_TEXT = "微信连接刚刚中断过，现在已恢复。我会继续处理当前任务。";
const WEIXIN_SESSION_EXPIRED_TEXT = "微信登录状态已失效，当前任务无法继续通过微信回复。请重新扫码登录后再试。";
const WEIXIN_MAX_PENDING_REPLIES_PER_CHAT = 20;
const WEIXIN_MAX_PENDING_TURNS_PER_CHAT = 20;
const WEIXIN_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const WEIXIN_LOGIN_RECOVERY_CHECK_INTERVAL_MS = 2000;
const WEIXIN_LOGIN_RECOVERY_TIMEOUT_MS = 2 * 60 * 1000;
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
let ilinkFetchCompatibilityInstalled = false;

export type WeixinChannelOptions = {
  credentialsPath?: string;
  mapper?: WeixinSessionMapper;
  liveReplyOptions?: Omit<ImLiveReplyControllerOptions<void>, "transport" | "onTransportError">;
  clientFactory?: (options: ClientOptions) => WeixinIlinkClient;
  loginWithQR?: typeof loginWithQR;
  onStateChange?: (state: WeixinSessionMapperState) => void;
};

type SavedCredentials = {
  baseUrl: string;
  botToken: string;
  accountId: string;
  cursor?: string;
};

type QueuedWeixinTurn = {
  sessionKey: string;
  message: string;
  projectKey?: string;
  attachments: ChannelAttachment[];
};

export type WeixinIlinkClient = {
  cursor: string;
  poll(): Promise<GetUpdatesResp>;
  sendTextChunked(toUserId: string, text: string, contextToken: string, maxLength?: number): Promise<number>;
  sendMedia(toUserId: string, item: unknown, contextToken: string): Promise<unknown>;
  getUploadUrl(params: WeixinUploadUrlRequest): Promise<WeixinUploadUrlResponse>;
  sendTyping(userId: string, contextToken?: string): Promise<void>;
};

type WeixinUploadUrlRequest = {
  filekey: string;
  media_type: 1 | 3;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
};

type WeixinUploadUrlResponse = {
  ret?: number;
  errmsg?: string;
  upload_param?: string;
  upload_full_url?: string;
  upload_url?: string;
  cdn_url?: string;
  download_url?: string;
};

export class WeixinChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "weixin";

  private readonly credentialsPath: string;
  private readonly mapper: WeixinSessionMapper;
  private readonly liveReplyOptions?: WeixinChannelOptions["liveReplyOptions"];
  private readonly clientFactory: (options: ClientOptions) => WeixinIlinkClient;
  private readonly login: typeof loginWithQR;
  private readonly onStateChange?: (state: WeixinSessionMapperState) => void;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client?: WeixinIlinkClient;
  private loopAbort = new AbortController();
  private pollPromise: Promise<void> | null = null;
  private activeChats = new Set<string>();
  private activeLiveReplies = new Map<string, ImLiveReplyController<void>>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();
  private contextTokens = new Map<string, string>();
  private consecutivePollErrors = 0;
  private connectionIssueNotified = false;
  private connectionIssueChats = new Set<string>();
  private connectionLostNoticeDeliveredChats = new Set<string>();
  private pendingReplies = new Map<string, string[]>();
  private readonly chatState = new ImChatSessionState<QueuedWeixinTurn>({ maxPendingTurns: WEIXIN_MAX_PENDING_TURNS_PER_CHAT });
  private attachmentStore: ImAttachmentStore;
  private loginRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private loginRecoveryPromise: Promise<void> | null = null;

  constructor(options: WeixinChannelOptions = {}) {
    this.credentialsPath = options.credentialsPath ?? CREDENTIALS_PATH;
    this.mapper = options.mapper ?? new WeixinSessionMapper();
    this.liveReplyOptions = options.liveReplyOptions;
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new ILinkClient(clientOptions) as unknown as WeixinIlinkClient);
    this.login = options.loginWithQR ?? loginWithQR;
    this.onStateChange = options.onStateChange;
    this.attachmentStore = new ImAttachmentStore({
      rootDir: join(homedir(), ".pilotdeck", "im-attachments"),
      channelKey: this.channelKey,
      maxBytes: WEIXIN_MAX_ATTACHMENT_BYTES,
    });
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;
    this.loopAbort = new AbortController();

    const creds = await this.ensureLoggedIn();
    if (creds) {
      this.startPollingWithCredentials(creds);
    } else {
      this.startLoginRecoveryWatcher();
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`weixin: stopping (${reason ?? "no reason"})`);
        this.loopAbort.abort();
        this.clearLoginRecoveryTimer();
        this.saveCursor();
        try { await this.pollPromise; } catch { /* ignore */ }
        try { await this.loginRecoveryPromise; } catch { /* ignore */ }
        this.pollPromise = null;
        this.loginRecoveryPromise = null;
      },
    };
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (userId, text) =>
      this.sendReply(userId, text, { queueOnFailure: true }),
    );
  }

  private startPollingWithCredentials(creds: SavedCredentials): void {
    if (this.pollPromise) {
      this.logger?.warn?.("weixin: poll loop already running, skip duplicate start");
      return;
    }

    installIlinkFetchCompatibility();
    this.client = this.createClient(creds);

    this.loopAbort = new AbortController();
    this.pollPromise = this.pollLoop();
    this.logger?.info?.("weixin: connected, poll loop started");
  }

  private startLoginRecoveryWatcher(): void {
    if (this.loginRecoveryPromise) return;

    this.logger?.warn?.("weixin: QR login failed, watching credentials for recovery");
    this.loginRecoveryPromise = this.watchCredentialsForLoginRecovery(this.loopAbort.signal);
  }

  private async watchCredentialsForLoginRecovery(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + WEIXIN_LOGIN_RECOVERY_TIMEOUT_MS;

    while (!signal.aborted && !this.pollPromise) {
      const creds = this.loadCredentials();
      if (creds) {
        this.logger?.info?.(`weixin: loaded saved credentials (account: ${creds.accountId})`);
        this.clearLoginRecoveryTimer();
        this.startPollingWithCredentials(creds);
        return;
      }

      if (Date.now() >= deadline) {
        this.logger?.warn?.("weixin: QR login recovery timed out");
        return;
      }

      await this.sleepLoginRecovery(signal);
    }
  }

  private async sleepLoginRecovery(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.clearLoginRecoveryTimer();
        signal.removeEventListener("abort", finish);
        resolve();
      };

      this.loginRecoveryTimer = setTimeout(() => {
        this.loginRecoveryTimer = null;
        finish();
      }, WEIXIN_LOGIN_RECOVERY_CHECK_INTERVAL_MS);

      if (signal.aborted) {
        finish();
      } else {
        signal.addEventListener("abort", finish, { once: true });
      }
    });
  }

  private clearLoginRecoveryTimer(): void {
    if (!this.loginRecoveryTimer) return;
    clearTimeout(this.loginRecoveryTimer);
    this.loginRecoveryTimer = null;
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
        if (resp.errcode === -14) {
          this.logger?.error?.("weixin: session expired (errcode -14), need re-login");
          console.error("[weixin] Session 过期，请删除凭证文件并重启以重新扫码登录:");
          console.error(`[weixin]   rm ${this.credentialsPath}`);
          await this.notifyActiveChats(WEIXIN_SESSION_EXPIRED_TEXT);
          break;
        }

        if (resp.ret !== 0 && resp.ret !== undefined) {
          this.logger?.warn?.(`weixin: poll ret=${resp.ret} errmsg=${resp.errmsg}`);
          await this.notifyConnectionLost();
          await this.sleep(POLL_RETRY_DELAY_MS);
          continue;
        }

        if (this.consecutivePollErrors > 0) {
          this.logger?.info?.(`weixin: poll recovered after ${this.consecutivePollErrors} error(s)`);
          this.consecutivePollErrors = 0;
        }
        await this.notifyConnectionRecovered();
        await this.flushPendingReplies();

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
        await this.notifyConnectionLost();
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

    const extracted = await this.extractIncomingMessage(msg, fromUser);
    const text = extracted.text;

    if (!text.trim() && extracted.attachments.length === 0) return;
    this.logger?.info?.(`weixin: received message from ${fromUser} attachments=${extracted.attachments.length}`);

    const messageText = text.trim() || (extracted.attachments.length > 0 ? "请查看我发送的附件。" : "");
    const previousSessionKey = this.mapper.getSession(fromUser);
    const mapped = this.mapper.resolve({ chatId: fromUser, text: messageText });
    if (mapped.command === "new") {
      this.onStateChange?.(this.mapper.snapshot());
      const activeRun = this.chatState.activeRun(fromUser);
      this.resetChatInteractionState(fromUser);
      await this.gateway?.abortTurn({
        sessionKey: activeRun?.sessionKey ?? previousSessionKey,
        ...(activeRun?.runId ? { runId: activeRun.runId } : {}),
      }).catch((error: unknown) => {
        this.logger?.warn?.(`weixin: abort previous session on /new failed: ${formatWeixinError(error)}`);
      });
      if (!mapped.message) {
        await this.sendReply(fromUser, "已创建新会话。");
        return;
      }
    }

    if (this.elicitation.hasPending(fromUser) && this.gateway) {
      try {
        const confirmation = await this.elicitation.answer(fromUser, text, this.gateway);
        if (confirmation) await this.sendReply(fromUser, confirmation);
      } catch (e) {
        this.logger?.error?.(`weixin: elicitation answer error: ${e}`);
      }
      return;
    }

    if (this.permissions.hasPending(fromUser) && this.gateway) {
      try {
        const trimmed = text.trim();
        const confirmation = await this.permissions.answer(fromUser, text, this.gateway);
        if (confirmation) await this.sendReply(fromUser, confirmation);
        if (trimmed === "1" || trimmed === "2") {
          await this.activeLiveReplies.get(fromUser)?.resumeActivity("tool", { immediate: false });
        }
      } catch (e) {
        this.logger?.error?.(`weixin: permission answer error: ${e}`);
      }
      return;
    }

    if (this.gateway && text.trim().startsWith("/")) {
      const handled = await executeChannelCommand(text, {
        gateway: this.gateway,
        chatId: fromUser,
        channelKey: "weixin",
        reply: async (msg) => {
          await this.sendReply(fromUser, msg);
        },
        bindProject: (projectKey) => { this.mapper.bindProject(fromUser, projectKey); this.onStateChange?.(this.mapper.snapshot()); },
        getProject: () => this.mapper.getProject(fromUser),
        resetSession: () => { this.mapper.resolve({ chatId: fromUser, text: "/new" }); this.onStateChange?.(this.mapper.snapshot()); },
        logger: this.logger as any,
      });
      if (handled) return;
    }

    if (!mapped.message) return;

    if (this.activeChats.has(fromUser)) {
      this.queuePendingTurn(fromUser, {
        sessionKey: mapped.sessionKey,
        message: mapped.message,
        projectKey: mapped.projectKey,
        attachments: extracted.attachments,
      });
      this.logger?.info?.(`weixin: chat ${fromUser} already active, queued message`);
      return;
    }

    await this.runQueuedTurns(fromUser, {
      sessionKey: mapped.sessionKey,
      message: mapped.message,
      projectKey: mapped.projectKey,
      attachments: extracted.attachments,
    });
  }

  private queuePendingTurn(userId: string, turn: QueuedWeixinTurn): void {
    this.chatState.queueTurn(userId, turn);
  }

  private resetChatInteractionState(userId: string): void {
    this.chatState.resetForNewSession(userId);
    this.elicitation.clear(userId);
    this.permissions.clear(userId);
    this.pendingReplies.delete(userId);
  }

  private async runQueuedTurns(userId: string, firstTurn: QueuedWeixinTurn): Promise<void> {
    this.activeChats.add(userId);
    try {
      let nextTurn: QueuedWeixinTurn | undefined = firstTurn;
      while (nextTurn) {
        await this.processMessage(
          userId,
          nextTurn.sessionKey,
          nextTurn.message,
          nextTurn.projectKey,
          nextTurn.attachments,
        );

        nextTurn = this.chatState.shiftTurn(userId);
      }
    } finally {
      this.activeChats.delete(userId);
    }
  }

  private async extractIncomingMessage(
    msg: WeixinMessage,
    fromUser: string,
  ): Promise<{ text: string; attachments: ChannelAttachment[] }> {
    const textParts: string[] = [];
    const attachments: ChannelAttachment[] = [];
    const diagnostics: string[] = [];
    const messageId = String(msg.message_id ?? msg.client_id ?? Date.now());

    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        textParts.push(item.text_item.text);
        continue;
      }
      try {
        if (item.type === MessageItemType.IMAGE) {
          const image = item.image_item;
          const url = image?.cdn_url ?? image?.url ?? extractWeixinMediaUrl(image);
          if (!url) {
            diagnostics.push("微信图片附件缺少下载 URL，已跳过。调试信息：image_item 中未找到 url/cdn_url/media.full_url。");
            continue;
          }
          attachments.push(await this.attachmentStore.saveFromUrl({
            url,
            chatId: fromUser,
            messageId,
            type: "image",
            name: `image-${messageId}.jpg`,
            mimeType: guessMimeTypeFromUrl(url, "image/jpeg"),
            transform: (buffer) => this.decryptWeixinImageOrThrow(buffer, image),
            metadata: {
              width: image?.width,
              height: image?.height,
              itemType: "image",
              source: image?.cdn_url || image?.url ? "url" : "media.full_url",
            },
          }));
          continue;
        }
        if (item.type === MessageItemType.FILE) {
          const file = item.file_item;
          const url = file?.cdn_url ?? file?.url ?? extractWeixinMediaUrl(file);
          if (!url) {
            diagnostics.push(`微信文件 ${file?.file_name ?? "(unknown)"} 缺少下载 URL，已跳过。调试信息：file_item 中未找到 url/cdn_url/media.full_url。`);
            continue;
          }
          attachments.push(await this.attachmentStore.saveFromUrl({
            url,
            chatId: fromUser,
            messageId,
            type: "file",
            name: file?.file_name,
            bytes: file?.file_size,
            mimeType: guessMimeTypeFromName(file?.file_name),
            transform: (buffer) => this.decryptWeixinFile(buffer, file),
            metadata: {
              itemType: "file",
              source: file?.cdn_url || file?.url ? "url" : "media.full_url",
            },
          }));
          continue;
        }
        if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
          textParts.push(`[微信语音转文字]\n${item.voice_item.text}`);
          continue;
        }
        if (item.type === MessageItemType.VIDEO) {
          diagnostics.push("微信视频附件暂未接入内容理解，已跳过。");
        }
      } catch (error) {
        diagnostics.push(`微信附件处理失败：${formatWeixinError(error)}`);
      }
    }

    if (diagnostics.length > 0) {
      textParts.push(`[Attachment diagnostics]\n${diagnostics.map((line) => `- ${line}`).join("\n")}`);
    }
    return { text: textParts.join("\n").trim(), attachments };
  }

  private decryptWeixinImageOrThrow(buffer: Buffer, image: unknown): Buffer {
    const result = decryptWeixinMediaIfNeeded(buffer, image);
    const keyDiagnostics = summarizeWeixinMediaKeyShape(image);
    const candidateDiagnostics = summarizeWeixinDecryptCandidates(buffer, image);
    this.logger?.info?.(
      `weixin: image decrypt input=${buffer.byteLength} output=${result.byteLength} `
      + `changed=${result !== buffer} image=${isKnownImageBuffer(result)} ${keyDiagnostics} ${candidateDiagnostics}`,
    );
    if (!isKnownImageBuffer(result)) {
      throw new Error(`微信图片解密后仍不是可识别图片（${keyDiagnostics} ${candidateDiagnostics}）`);
    }
    return result;
  }

  private decryptWeixinFile(buffer: Buffer, file: unknown): Buffer {
    const result = decryptWeixinMediaIfNeeded(buffer, file, isLikelyKnownFileBuffer);
    const keyDiagnostics = summarizeWeixinMediaKeyShape(file);
    this.logger?.info?.(
      `weixin: file decrypt input=${buffer.byteLength} output=${result.byteLength} `
      + `changed=${result !== buffer} known=${isLikelyKnownFileBuffer(result)} ${keyDiagnostics}`,
    );
    return result;
  }

  private async processMessage(
    userId: string,
    sessionKey: string,
    message: string,
    projectKey?: string,
    attachments: ChannelAttachment[] = [],
  ): Promise<void> {
    if (!this.gateway) return;
    const generation = this.chatState.generation(userId);
    const isCurrentTurn = () => this.chatState.isCurrent(userId, generation);

    const turnTimeoutMs = this.liveReplyOptions?.turnTimeoutMs ?? WEIXIN_DEFAULT_TURN_TIMEOUT_MS;
    const liveReply = new ImLiveReplyController<void>({
      ...this.liveReplyOptions,
      turnTimeoutMs,
      activityDelayMs: this.liveReplyOptions?.activityDelayMs ?? WEIXIN_ACTIVITY_DELAY_MS,
      activityUpdateThrottleMs:
        this.liveReplyOptions?.activityUpdateThrottleMs ?? WEIXIN_ACTIVITY_UPDATE_THROTTLE_MS,
      activityMaxUpdates: this.liveReplyOptions?.activityMaxUpdates ?? WEIXIN_ACTIVITY_MAX_UPDATES,
      activityTtlMs: this.liveReplyOptions?.activityTtlMs ?? WEIXIN_ACTIVITY_TTL_MS,
      formatActivity: this.liveReplyOptions?.formatActivity ?? formatWeixinActivity,
      timeoutFinalText: this.liveReplyOptions?.timeoutFinalText ?? WEIXIN_TIMEOUT_FINAL_TEXT,
      transport: this.createLiveReplyTransport(userId),
      onTransportError: (error, phase) => {
        this.logger?.warn?.(`weixin: live reply ${phase} failed: ${formatWeixinError(error)}`);
      },
    });
    this.activeLiveReplies.set(userId, liveReply);
    let activeRunId: string | undefined;
    let watchdogSettled = false;
    let timeoutNotice: Promise<void> | undefined;
    const notifyTimedOut = (): Promise<void> => {
      timeoutNotice ??= liveReply.markTimedOut().catch((error: unknown) => {
        this.logger?.warn?.(`weixin: mark timeout failed: ${formatWeixinError(error)}`);
      });
      return timeoutNotice;
    };
    const watchdog = turnTimeoutMs > 0
      ? setTimeout(() => {
          if (watchdogSettled) return;
          watchdogSettled = true;
          this.logger?.warn?.(`weixin: live reply timed out for user ${userId}`);
          void notifyTimedOut()
            .then(() => this.gateway?.abortTurn({ sessionKey, ...(activeRunId ? { runId: activeRunId } : {}), reason: "system:timeout" }))
            .catch((error: unknown) => {
              this.logger?.warn?.(`weixin: abort timeout turn failed: ${formatWeixinError(error)}`);
            });
        }, turnTimeoutMs)
      : undefined;
    watchdog?.unref?.();

    try {
      void this.sendTypingIfPossible(userId);
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "weixin",
        message,
        ...(attachments.length > 0 ? { attachments } : {}),
        allowPlanModeTools: false,
        ...(turnTimeoutMs > 0 ? { timeoutMs: turnTimeoutMs } : {}),
        ...(projectKey ? { projectKey } : {}),
      })) {
        if (!isCurrentTurn()) break;
        if (event.type === "turn_started") {
          activeRunId = event.runId;
          this.chatState.setActiveRun(userId, { sessionKey, runId: activeRunId, generation });
        }
        if (event.type === "elicitation_request") {
          const questionText = this.elicitation.capture(userId, sessionKey, event);
          await liveReply.pauseActivity();
          await this.sendReply(userId, questionText);
          continue;
        }
        if (event.type === "permission_request") {
          const questionText = this.permissions.capture(userId, sessionKey, event);
          await liveReply.pauseActivity();
          if (questionText) await this.sendReply(userId, questionText);
          continue;
        }
        if (event.type === "error" && event.code === "agent_aborted") {
          if (timeoutNotice) {
            await timeoutNotice;
            continue;
          }
          await liveReply.markAborted();
          continue;
        }
        if (event.type === "error" && event.code === "turn_timeout") {
          watchdogSettled = true;
          await notifyTimedOut();
          continue;
        }
        if (event.type === "assistant_attachment") {
          await this.sendAttachment(userId, event.attachment);
          continue;
        }
        await liveReply.handleEvent(event);
      }
    } catch (e) {
      this.logger?.error?.(`weixin: submitTurn error: ${formatWeixinError(e)}`);
      await liveReply.handleEvent({
        type: "agent_status",
        event: "channel_submit_failed",
        detail: createVisibleErrorStatusDetail({
          message: "Failed to process this message. Please retry.",
          code: "channel_submit_failed",
          userHint: "PilotDeck failed before this IM turn could finish. Retry the message; if it repeats, check the channel and gateway logs.",
          scope: "channel",
          source: "im_channel",
          detail: {
            channel: "weixin",
          },
        }),
      });
    } finally {
      watchdogSettled = true;
      if (watchdog) clearTimeout(watchdog);
      await timeoutNotice;
      if (isCurrentTurn()) {
        this.activeLiveReplies.delete(userId);
      }
    }

    if (isCurrentTurn()) {
      this.chatState.clearActiveRun(userId);
      this.elicitation.clear(userId);
      this.permissions.clear(userId);
      await liveReply.flushFinal();
    }
  }

  private createLiveReplyTransport(userId: string): ImLiveReplyTransport<void> {
    return {
      send: async (text) => {
        await this.sendReply(userId, text, { queueOnFailure: true });
        return undefined;
      },
      pulseActivity: async (activity) => {
        await this.sendReply(userId, activity.text);
        await this.sendTypingIfPossible(userId);
        return true;
      },
      stopActivity: async () => true,
    };
  }

  private async sendReply(userId: string, text: string, options: { queueOnFailure?: boolean } = {}): Promise<boolean> {
    if (!this.client) {
      if (options.queueOnFailure) this.queuePendingReply(userId, text);
      return false;
    }
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) {
      this.logger?.warn?.(`weixin: no context_token for ${userId}, cannot send`);
      if (options.queueOnFailure) this.queuePendingReply(userId, text);
      return false;
    }
    try {
      await this.client.sendTextChunked(userId, text, contextToken, 2000);
      this.logger?.info?.(`weixin: sent reply to ${userId}`);
      return true;
    } catch (e) {
      this.logger?.error?.(`weixin: sendText failed: ${formatWeixinError(e)}`);
      if (options.queueOnFailure) this.queuePendingReply(userId, text);
      return false;
    }
  }

  private async sendAttachment(userId: string, attachment: GatewayOutboundAttachment): Promise<boolean> {
    if (!this.client) {
      await this.sendReply(userId, formatImAttachmentFallback(attachment), { queueOnFailure: true });
      return false;
    }
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) {
      await this.sendReply(userId, formatImAttachmentFallback(attachment), { queueOnFailure: true });
      return false;
    }

    return new ImAttachmentDelivery({
      maxBytes: WEIXIN_MAX_ATTACHMENT_BYTES,
      logger: this.logger,
      sendTextFallback: (text) => this.sendReply(userId, text, { queueOnFailure: true }).then(() => undefined),
      sendPrepared: (prepared) => this.uploadAndSendWeixinMedia(userId, contextToken, prepared),
    }).send(attachment);
  }

  private async uploadAndSendWeixinMedia(userId: string, contextToken: string, prepared: PreparedImAttachment): Promise<void> {
    if (!this.client) throw new Error("weixin client missing");
    this.logger?.info?.(`weixin: preparing attachment ${prepared.name} as ${prepared.fileType} bytes=${prepared.buffer.byteLength}`);
    const aeskey = randomBytes(16);
    const filekey = randomBytes(16).toString("hex");
    const upload = await this.client.getUploadUrl({
      filekey,
      media_type: prepared.fileType === "image" ? 1 : 3,
      to_user_id: userId,
      rawsize: prepared.buffer.byteLength,
      rawfilemd5: createHash("md5").update(prepared.buffer).digest("hex"),
      filesize: aesEcbPaddedSize(prepared.buffer.byteLength),
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    });
    this.logger?.info?.(`weixin: upload url response for ${prepared.name}: ${summarizeWeixinUploadResponse(upload)}`);
    if (typeof upload.ret === "number" && upload.ret !== 0) {
      throw new Error(`weixin getuploadurl failed ret=${upload.ret}${upload.errmsg ? ` errmsg=${upload.errmsg}` : ""}`);
    }
    const downloadParam = await uploadEncryptedBufferToWeixinCdn({ buffer: prepared.buffer, aeskey, filekey, upload });
    this.logger?.info?.(`weixin: CDN upload succeeded for ${prepared.name}`);
    const media = {
      encrypt_query_param: downloadParam,
      aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"),
      encrypt_type: 1,
    };
    await this.client.sendMedia(userId, prepared.fileType === "image"
      ? {
          type: MessageItemType.IMAGE,
          image_item: { media, mid_size: aesEcbPaddedSize(prepared.buffer.byteLength) },
        }
      : {
          type: MessageItemType.FILE,
          file_item: { file_name: prepared.name, len: String(prepared.buffer.byteLength), media },
        }, contextToken);
    this.logger?.info?.(`weixin: sent attachment to ${userId}: ${prepared.name}`);
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

  private async notifyConnectionLost(): Promise<void> {
    if (this.connectionIssueNotified) return;
    this.connectionIssueNotified = true;
    this.connectionIssueChats = new Set(this.activeChats);
    this.connectionLostNoticeDeliveredChats = await this.notifyActiveChats(WEIXIN_CONNECTION_LOST_TEXT);
  }

  private async notifyConnectionRecovered(): Promise<void> {
    if (!this.connectionIssueNotified) return;
    this.connectionIssueNotified = false;
    const chatsToNotify = new Set([...this.connectionIssueChats, ...this.activeChats]);
    await Promise.all([...chatsToNotify].map((userId) => {
      const text = this.connectionLostNoticeDeliveredChats.has(userId)
        ? WEIXIN_CONNECTION_RECOVERED_TEXT
        : WEIXIN_CONNECTION_RECOVERED_AFTER_LOSS_TEXT;
      return this.sendReply(userId, text);
    }));
    this.connectionIssueChats.clear();
    this.connectionLostNoticeDeliveredChats.clear();
  }

  private async notifyActiveChats(text: string): Promise<Set<string>> {
    const delivered = new Set<string>();
    if (this.activeChats.size === 0) return delivered;
    const results = await Promise.all(
      [...this.activeChats].map(async (userId) => ({
        userId,
        ok: await this.sendReply(userId, text),
      })),
    );
    for (const result of results) {
      if (result.ok) delivered.add(result.userId);
    }
    return delivered;
  }

  private queuePendingReply(userId: string, text: string): void {
    const pending = this.pendingReplies.get(userId) ?? [];
    pending.push(text);
    if (pending.length > WEIXIN_MAX_PENDING_REPLIES_PER_CHAT) {
      pending.splice(0, pending.length - WEIXIN_MAX_PENDING_REPLIES_PER_CHAT);
    }
    this.pendingReplies.set(userId, pending);
  }

  private async flushPendingReplies(): Promise<void> {
    if (this.pendingReplies.size === 0) return;
    for (const [userId, replies] of [...this.pendingReplies]) {
      while (replies.length > 0) {
        const text = replies[0];
        if (!(await this.sendReply(userId, text))) break;
        replies.shift();
      }
      if (replies.length === 0) {
        this.pendingReplies.delete(userId);
      }
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

function formatWeixinActivity(activity: { kind: "thinking" | "tool" | "subagent"; elapsedMs: number }): string {
  const elapsed = formatElapsed(activity.elapsedMs);
  const suffix = elapsed ? `（已用时 ${elapsed}）` : "";
  if (activity.kind === "tool") {
    return `仍在处理：正在执行工具${suffix}`;
  }
  if (activity.kind === "subagent") {
    return `仍在处理：正在处理子任务${suffix}`;
  }
  return `仍在处理：正在分析和生成回复${suffix}`;
}

function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 60_000) {
    return "";
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function guessMimeTypeFromUrl(url: string, fallback?: string): string | undefined {
  try {
    return guessMimeTypeFromName(new URL(url).pathname) ?? fallback;
  } catch {
    return fallback;
  }
}

function summarizeWeixinUploadResponse(upload: WeixinUploadUrlResponse | undefined): string {
  if (!upload) return "(empty)";
  return JSON.stringify({
    ret: upload.ret,
    errmsg: upload.errmsg,
    hasUploadParam: Boolean(upload.upload_param),
    hasUploadFullUrl: Boolean(upload.upload_full_url),
    hasUploadUrl: Boolean(upload.upload_url),
    hasCdnUrl: Boolean(upload.cdn_url),
    hasDownloadUrl: Boolean(upload.download_url),
  });
}

async function uploadEncryptedBufferToWeixinCdn(params: {
  buffer: Buffer;
  aeskey: Buffer;
  filekey: string;
  upload: WeixinUploadUrlResponse;
}): Promise<string> {
  const uploadUrl = params.upload.upload_full_url?.trim()
    || (params.upload.upload_param
      ? `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(params.upload.upload_param)}&filekey=${encodeURIComponent(params.filekey)}`
      : undefined);
  if (!uploadUrl) {
    throw new Error("weixin upload url response missing upload_full_url/upload_param");
  }
  const ciphertext = encryptAesEcb(params.buffer, params.aeskey);
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (res.status !== 200) {
    const errMsg = res.headers.get("x-error-message") ?? await res.text();
    throw new Error(`weixin CDN upload HTTP ${res.status}: ${errMsg}`);
  }
  const downloadParam = res.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("weixin CDN upload response missing x-encrypted-param");
  }
  return downloadParam;
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function extractWeixinMediaUrl(mediaOwner: unknown): string | undefined {
  if (!mediaOwner || typeof mediaOwner !== "object") return undefined;
  const media = (mediaOwner as Record<string, unknown>).media;
  if (!media || typeof media !== "object") return undefined;
  const record = media as Record<string, unknown>;
  const encryptedQueryParam = readString(record.encrypt_query_param);
  if (encryptedQueryParam) {
    return `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
  }
  return readString(record.full_url) ?? readString(record.download_url) ?? readString(record.url) ?? readString(record.cdn_url);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function decryptWeixinMediaIfNeeded(
  buffer: Buffer,
  mediaOwner: unknown,
  isExpectedBuffer: (candidate: Buffer) => boolean = isKnownImageBuffer,
): Buffer {
  if (isExpectedBuffer(buffer)) return buffer;
  for (const key of extractWeixinMediaKeys(mediaOwner)) {
    for (const deciphered of tryDecryptWeixinMedia(buffer, key)) {
      if (isExpectedBuffer(deciphered)) return deciphered;
    }
  }
  return buffer;
}

function summarizeWeixinMediaKeyShape(mediaOwner: unknown): string {
  if (!mediaOwner || typeof mediaOwner !== "object") return "keyShape=none";
  const owner = mediaOwner as Record<string, unknown>;
  const media = owner.media && typeof owner.media === "object" ? owner.media as Record<string, unknown> : undefined;
  const ownerAesKey = readString(owner.aeskey);
  const mediaAesKey = readString(media?.aes_key);
  const parts = [
    `ownerAesKeyLen=${ownerAesKey?.length ?? 0}`,
    `ownerAesKeyHex=${ownerAesKey ? /^[0-9a-fA-F]+$/.test(ownerAesKey.trim()) : false}`,
    `mediaAesKeyLen=${mediaAesKey?.length ?? 0}`,
    `mediaAesKeyDecodedLen=${mediaAesKey ? safeBase64DecodedLength(mediaAesKey) ?? "err" : 0}`,
  ];
  return `keyShape=${parts.join(",")}`;
}

function summarizeWeixinDecryptCandidates(buffer: Buffer, mediaOwner: unknown): string {
  const summaries: string[] = [];
  let index = 0;
  for (const key of extractWeixinMediaKeys(mediaOwner)) {
    const algorithm = key.length === 16 ? "aes-128" : key.length === 24 ? "aes-192" : key.length === 32 ? "aes-256" : `aes-${key.length}`;
    for (const candidate of tryDecryptWeixinMedia(buffer, key)) {
      summaries.push(`${index}:${algorithm}:len=${candidate.byteLength}:head=${candidate.subarray(0, 8).toString("hex")}:image=${isKnownImageBuffer(candidate)}`);
      index++;
    }
  }
  return `candidates=[${summaries.join(";")}]`;
}

function safeBase64DecodedLength(value: string): number | undefined {
  try {
    return Buffer.from(value, "base64").length;
  } catch {
    return undefined;
  }
}

function extractWeixinMediaKeys(mediaOwner: unknown): Buffer[] {
  if (!mediaOwner || typeof mediaOwner !== "object") return [];
  const owner = mediaOwner as Record<string, unknown>;
  const media = owner.media && typeof owner.media === "object" ? owner.media as Record<string, unknown> : undefined;
  const keys: Buffer[] = [];
  const seen = new Set<string>();
  const push = (key: Buffer | undefined) => {
    if (!key || (key.length !== 16 && key.length !== 24 && key.length !== 32)) return;
    const id = key.toString("hex");
    if (seen.has(id)) return;
    seen.add(id);
    keys.push(key);
  };
  const ownerAesKey = readString(owner.aeskey);
  if (ownerAesKey && /^[0-9a-fA-F]{32}$/.test(ownerAesKey.trim())) {
    push(Buffer.from(ownerAesKey.trim(), "hex"));
  }
  const mediaAesKey = readString(media?.aes_key);
  if (mediaAesKey) {
    const decoded = Buffer.from(mediaAesKey, "base64");
    if (decoded.length === 16 || decoded.length === 24 || decoded.length === 32) push(decoded);
    const text = decoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(text)) push(Buffer.from(text, "hex"));
  }
  if (ownerAesKey && !/^[0-9a-fA-F]{32}$/.test(ownerAesKey.trim())) {
    const decoded = Buffer.from(ownerAesKey, "base64");
    if (decoded.length === 16 || decoded.length === 24 || decoded.length === 32) push(decoded);
  }
  return keys;
}

function tryDecryptWeixinMedia(buffer: Buffer, key: Buffer): Buffer[] {
  const algorithm = key.length === 16 ? "aes-128" : key.length === 24 ? "aes-192" : key.length === 32 ? "aes-256" : undefined;
  if (!algorithm) return [];
  const outputs: Buffer[] = [];
  try {
    const decipher = createDecipheriv(`${algorithm}-ecb`, key, null);
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(buffer), decipher.final()]);
    outputs.push(stripPkcs7Padding(padded) ?? padded);
  } catch {
    // Wrong key or malformed ciphertext.
  }
  return outputs;
}

function stripPkcs7Padding(buffer: Buffer): Buffer | undefined {
  if (buffer.length === 0) return undefined;
  const pad = buffer[buffer.length - 1];
  if (!pad || pad > 16 || pad > buffer.length) return undefined;
  for (const byte of buffer.subarray(buffer.length - pad)) {
    if (byte !== pad) return undefined;
  }
  return buffer.subarray(0, buffer.length - pad);
}

function isKnownImageBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }
  const gifHeader = buffer.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return true;
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return true;
  }
  return false;
}

function isLikelyKnownFileBuffer(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  if (isKnownImageBuffer(buffer)) return true;
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return true;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return true;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) return true;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))) return true;
  if (buffer.subarray(0, 4).toString("ascii") === "{\\rt") return true;
  return looksLikeMostlyText(buffer.subarray(0, Math.min(buffer.length, 512)));
}

function looksLikeMostlyText(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e) || byte >= 0x80) {
      printable++;
    }
  }
  return printable / buffer.length > 0.9;
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
