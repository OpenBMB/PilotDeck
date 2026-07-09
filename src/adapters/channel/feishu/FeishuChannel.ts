import { createDecipheriv, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { ChannelAttachment, Gateway } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { executeChannelCommand, resolveCommand } from "../protocol/ChannelCommandRegistry.js";
import { guessMimeTypeFromName, ImAttachmentDelivery, type PreparedImAttachment } from "../protocol/ImAttachmentDelivery.js";
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
import { FeishuSessionMapper, type FeishuSessionMapperState } from "./FeishuSessionMapper.js";
import { type FeishuLiveCardActivityKind } from "./feishu-render.js";
import { createVisibleErrorStatusDetail } from "../../../status/agentStatus.js";

let Lark: any = null;
let larkLoadAttempted = false;
async function loadLarkSdk(): Promise<any> {
  if (Lark || larkLoadAttempted) return Lark;
  larkLoadAttempted = true;
  try {
    const mod = await import("@larksuiteoapi/node-sdk");
    Lark = (mod as { default?: unknown }).default ?? mod;
  } catch {
    Lark = null;
  }
  return Lark;
}

const TENANT_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const SEND_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";
const FEISHU_IMAGE_UPLOAD_URL = "https://open.feishu.cn/open-apis/im/v1/images";
const FEISHU_FILE_UPLOAD_URL = "https://open.feishu.cn/open-apis/im/v1/files";
const FEISHU_MESSAGE_RESOURCE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
const REACTION_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
const UPDATE_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
const PROCESSING_EMOJI = "OnIt";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const SEEN_EVENTS_MAX = 2000;
const MAX_TEXT_MESSAGE_LENGTH = 4000;
const DEFAULT_LIVE_REPLY_CURSOR = " ▉";
const FEISHU_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const FEISHU_ATTACHMENT_FETCH_TIMEOUT_MS = 60_000;
const FEISHU_MAX_PENDING_TURNS_PER_CHAT = 20;
const FEISHU_MULTI_ATTACHMENT_BATCH_MS = 250;

export type FeishuOutboundMessage = {
  chatId: string;
  text: string;
};

export type FeishuLiveMessageHandle = {
  messageId: string;
  livePost: boolean;
};

export type FeishuConnectionMode = "stream" | "webhook";

export type FeishuChannelOptions = {
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verifyToken?: string;
  /**
   * "stream" (default): outbound WebSocket via @larksuiteoapi/node-sdk — no
   * public URL needed, identical to weixin-ilink long-polling.
   * "webhook": passive mode where Lark POSTs to /feishu/webhook (requires
   * a public tunnel).
   */
  connectionMode?: FeishuConnectionMode;
  /** "feishu" (open.feishu.cn) or "lark" (open.larksuite.com). */
  domainName?: "feishu" | "lark";
  mapper?: FeishuSessionMapper;
  /**
   * Optional override for outbound delivery (used in tests). When omitted the
   * channel calls Lark Open API directly.
   */
  send?: (message: FeishuOutboundMessage) => Promise<void>;
  liveReplyOptions?: Omit<
    ImLiveReplyControllerOptions<FeishuLiveMessageHandle>,
    "transport" | "onTransportError"
  >;
  onStateChange?: (state: FeishuSessionMapperState) => void;
};

type ParsedEvent =
  | { kind: "url_verification"; challenge: string }
  | {
      kind: "message";
      eventId: string;
      chatId: string;
      text: string;
      messageId?: string;
      messageType?: string;
      content?: string;
    }
  | { kind: "ignore" };

type FeishuInboundMessage = {
  chatId: string;
  text: string;
  eventId: string;
  messageId?: string;
  messageType?: string;
  content?: string;
};

type QueuedFeishuTurn = {
  sessionKey: string;
  message: string;
  projectKey?: string;
  attachments: ChannelAttachment[];
  messageId?: string;
  generation: number;
};

type FeishuInboundBatch = {
  messages: FeishuInboundMessage[];
  timer?: ReturnType<typeof setTimeout>;
  draining: boolean;
};

export class FeishuChannel implements ChannelAdapter {
  readonly channelKey = "feishu";

  private readonly mapper: FeishuSessionMapper;
  private readonly explicitSend?: (message: FeishuOutboundMessage) => Promise<void>;
  private readonly liveReplyOptions?: FeishuChannelOptions["liveReplyOptions"];
  private readonly onStateChange?: (state: FeishuSessionMapperState) => void;

  private appId: string;
  private appSecret: string;
  private encryptKey?: string;
  private verifyToken?: string;
  private connectionMode: FeishuConnectionMode;
  private domainName: "feishu" | "lark";

  private gateway?: Gateway;
  private logger?: ChannelLogger;

  private tokenCache?: { value: string; expiresAt: number };
  private tokenInflight?: Promise<string>;
  private readonly seenEvents = new Set<string>();
  private readonly activeChats = new Set<string>();
  private readonly chatState = new ImChatSessionState<QueuedFeishuTurn>({ maxPendingTurns: FEISHU_MAX_PENDING_TURNS_PER_CHAT });
  private readonly inboundBatches = new Map<string, FeishuInboundBatch>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();
  private readonly attachmentStore = new ImAttachmentStore({
    rootDir: join(homedir(), ".pilotdeck", "im-attachments"),
    channelKey: "feishu",
    maxBytes: FEISHU_MAX_ATTACHMENT_BYTES,
    fetchTimeoutMs: FEISHU_ATTACHMENT_FETCH_TIMEOUT_MS,
  });

  private wsClient: any = null;

  constructor(options: FeishuChannelOptions = {}) {
    this.mapper = options.mapper ?? new FeishuSessionMapper();
    this.explicitSend = options.send;
    this.liveReplyOptions = options.liveReplyOptions;
    this.appId = options.appId ?? "";
    this.appSecret = options.appSecret ?? "";
    this.encryptKey = options.encryptKey;
    this.verifyToken = options.verifyToken;
    this.connectionMode = options.connectionMode ?? "stream";
    this.domainName = options.domainName ?? "feishu";
    this.onStateChange = options.onStateChange;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    const cfg = deps.config?.adapters?.feishu;
    if (cfg) {
      this.appId = this.appId || cfg.appId || "";
      this.appSecret = this.appSecret || cfg.appSecret || "";
      this.encryptKey = this.encryptKey ?? cfg.encryptKey;
      this.verifyToken = this.verifyToken ?? cfg.verifyToken;
    }

    if (!this.explicitSend && (!this.appId || !this.appSecret)) {
      this.logger?.warn?.(
        "feishu: appId/appSecret not configured; outbound replies will not be sent. " +
          "Configure adapters.feishu.appId/appSecret in pilotdeck.yaml.",
      );
      return { stop: async () => undefined };
    }

    if (this.connectionMode === "stream") {
      const ok = await this.startStreamMode();
      if (!ok) {
        this.logger?.warn?.(
          "feishu: stream mode failed to start; falling back to webhook-only " +
            "(set adapters.feishu.connectionMode: webhook in pilotdeck.yaml to silence this).",
        );
      }
    } else {
      this.logger?.info?.(
        `feishu: ready in webhook mode (appId=${maskAppId(this.appId)}); waiting for POST /feishu/webhook`,
      );
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`feishu: stopping (${reason ?? "no reason"})`);
        if (this.wsClient && typeof this.wsClient.stop === "function") {
          try { this.wsClient.stop(); } catch { /* best effort */ }
        }
        this.wsClient = null;
      },
    };
  }

  private async startStreamMode(): Promise<boolean> {
    const sdk = await loadLarkSdk();
    if (!sdk) {
      this.logger?.error?.(
        "feishu: @larksuiteoapi/node-sdk failed to load; run `npm install @larksuiteoapi/node-sdk` " +
          "or set adapters.feishu.connectionMode: webhook",
      );
      return false;
    }

    try {
      const dispatcher = new sdk.EventDispatcher({}).register({
        "im.message.receive_v1": (data: unknown) => {
          this.logger?.info?.("feishu: ★ im.message.receive_v1 fired");
          void this.handleStreamEvent(data).catch((e: unknown) => {
            this.logger?.error?.(`feishu: stream event handler error: ${e}`);
          });
        },
      });

      const domain =
        this.domainName === "lark"
          ? sdk.Domain?.Lark ?? "https://open.larksuite.com"
          : sdk.Domain?.Feishu ?? "https://open.feishu.cn";

      this.wsClient = new sdk.WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain,
        loggerLevel: sdk.LoggerLevel?.info ?? 2,
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
      this.logger?.info?.(`feishu: stream mode connected (appId=${maskAppId(this.appId)})`);
      return true;
    } catch (e) {
      this.logger?.error?.(`feishu: stream mode start failed: ${e}`);
      return false;
    }
  }

  private async handleStreamEvent(data: unknown): Promise<void> {
    const raw = data as Record<string, unknown>;
    const message = (raw.message ?? (raw as { event?: { message?: unknown } }).event?.message) as
      | { chat_id?: string; content?: string; message_type?: string; message_id?: string }
      | undefined;
    if (!message) return;
    if (!isSupportedFeishuInboundType(message.message_type)) return;

    const chatId = message.chat_id;
    if (!chatId || message.content === undefined) return;

    const text = extractFeishuMessageText(message.message_type, message.content);
    const messageId = message.message_id;
    const eventId = messageId ?? `stream:${chatId}:${Date.now()}`;

    if (this.seenEvents.has(eventId)) return;
    this.rememberEvent(eventId);

    this.enqueueInboundMessage({
      chatId,
      text,
      eventId,
      messageId,
      messageType: message.message_type,
      content: message.content,
    });
  }

  async handleWebhook(request: IncomingMessage, response: ServerResponse, body: string): Promise<boolean> {
    if (!this.gateway) {
      respondJson(response, 503, { error: "feishu_not_started" });
      return true;
    }

    const parsed = this.parseInbound(body);

    if (parsed.kind === "url_verification") {
      respondJson(response, 200, { challenge: parsed.challenge });
      return true;
    }

    if (parsed.kind === "ignore") {
      respondJson(response, 200, { ok: true });
      return true;
    }

    if (this.seenEvents.has(parsed.eventId)) {
      respondJson(response, 200, { ok: true, deduped: true });
      return true;
    }
    this.rememberEvent(parsed.eventId);

    respondJson(response, 200, { ok: true });
    this.enqueueInboundMessage(parsed);
    return true;
  }

  private enqueueInboundMessage(input: FeishuInboundMessage): void {
    const batch = this.inboundBatches.get(input.chatId) ?? { messages: [], draining: false };
    batch.messages.push(input);
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      void this.drainInboundBatch(input.chatId).catch((error: unknown) => {
        this.logger?.error?.(`feishu: drainInboundBatch error: ${error}`);
      });
    }, shouldBatchFeishuMessage(input) ? FEISHU_MULTI_ATTACHMENT_BATCH_MS : 0);
    batch.timer.unref?.();
    this.inboundBatches.set(input.chatId, batch);
  }

  private async drainInboundBatch(chatId: string): Promise<void> {
    const batch = this.inboundBatches.get(chatId);
    if (!batch || batch.draining) return;
    batch.draining = true;
    try {
      while (batch.messages.length > 0) {
        const messages = batch.messages.splice(0);
        const grouped = groupFeishuInboundMessages(messages);
        for (const group of grouped) {
          await this.processInboundMessages(group);
        }
      }
    } finally {
      batch.draining = false;
      if (batch.messages.length === 0) {
        this.inboundBatches.delete(chatId);
      } else {
        this.inboundBatches.set(chatId, batch);
        void this.drainInboundBatch(chatId).catch((error: unknown) => {
          this.logger?.error?.(`feishu: drainInboundBatch retry error: ${error}`);
        });
      }
    }
  }

  private async processInboundMessages(inputs: FeishuInboundMessage[]): Promise<void> {
    if (!this.gateway) return;
    const first = inputs[0];
    if (!first) return;
    const chatId = first.chatId;
    const attachmentResults = await Promise.all(inputs.map((input) => this.extractIncomingAttachments(input)));
    const attachments = attachmentResults.flatMap((result) => result.attachments);
    const diagnostics = attachmentResults.flatMap((result) => result.diagnostics);
    const text = mergeTextAndDiagnostics(inputs.map((input) => input.text).filter(Boolean).join("\n"), diagnostics);
    const messageText = text.trim() || (attachments.length > 0 ? "请查看我发送的附件。" : "");
    if (!messageText.trim() && attachments.length === 0) return;

    if (this.elicitation.hasPending(chatId)) {
      try {
        const confirmation = await this.elicitation.answer(chatId, messageText, this.gateway);
        if (confirmation) await this.send({ chatId, text: confirmation });
      } catch (e) {
        this.logger?.error?.(`feishu: elicitation answer error: ${e}`);
      }
      return;
    }

    if (this.permissions.hasPending(chatId)) {
      try {
        const confirmation = await this.permissions.answer(chatId, messageText, this.gateway);
        if (confirmation) await this.send({ chatId, text: confirmation });
      } catch (e) {
        this.logger?.error?.(`feishu: permission answer error: ${e}`);
      }
      return;
    }

    const previousSessionKey = this.mapper.getSession(chatId);
    const mapped = this.mapper.resolve({ chatId, text: messageText });

    if (mapped.command === "new") {
      this.onStateChange?.(this.mapper.snapshot());
      const activeRun = this.chatState.activeRun(chatId);
      this.resetChatInteractionState(chatId);
      await this.gateway?.abortTurn({
        sessionKey: activeRun?.sessionKey ?? previousSessionKey,
        ...(activeRun?.runId ? { runId: activeRun.runId } : {}),
      }).catch((error: unknown) => {
        this.logger?.warn?.(`feishu: abort previous session on /new failed: ${formatError(error)}`);
      });
      if (!mapped.message) {
        await this.send({ chatId, text: "已创建新会话。" });
        return;
      }
    }

    // Delegate system-level commands (e.g. /projects, /update, /status) to
    // the centralized registry — no need to handle them individually here.
    if (messageText.trim().startsWith("/")) {
      const handled = await executeChannelCommand(messageText, {
        gateway: this.gateway,
        chatId,
        channelKey: "feishu",
        reply: (msg) => this.send({ chatId, text: msg }),
        bindProject: (projectKey) => { this.mapper.bindProject(chatId, projectKey); this.onStateChange?.(this.mapper.snapshot()); },
        getProject: () => this.mapper.getProject(chatId),
        resetSession: () => { this.mapper.resolve({ chatId, text: "/new" }); this.onStateChange?.(this.mapper.snapshot()); },
        logger: this.logger as any,
      });
      if (handled) return;
    }

    if (!mapped.message) return;

    if (this.activeChats.has(chatId)) {
      this.chatState.queueTurn(chatId, {
        sessionKey: mapped.sessionKey,
        message: mapped.message,
        projectKey: mapped.projectKey,
        attachments,
        messageId: first.messageId,
        generation: this.chatState.generation(chatId),
      });
      this.logger?.info?.(`feishu: chat ${chatId} already active, queued message`);
      return;
    }

    await this.runQueuedTurns(chatId, {
      sessionKey: mapped.sessionKey,
      message: mapped.message,
      projectKey: mapped.projectKey,
      attachments,
      messageId: first.messageId,
      generation: this.chatState.generation(chatId),
    });
  }

  private resetChatInteractionState(chatId: string): void {
    this.chatState.resetForNewSession(chatId);
    this.elicitation.clear(chatId);
    this.permissions.clear(chatId);
    const batch = this.inboundBatches.get(chatId);
    if (batch?.timer) clearTimeout(batch.timer);
    this.inboundBatches.delete(chatId);
  }

  private async runQueuedTurns(chatId: string, firstTurn: QueuedFeishuTurn): Promise<void> {
    this.activeChats.add(chatId);
    try {
      let nextTurn: QueuedFeishuTurn | undefined = firstTurn;
      while (nextTurn) {
        await this.processTurn(chatId, nextTurn);
        nextTurn = this.chatState.shiftTurn(chatId);
      }
    } finally {
      this.activeChats.delete(chatId);
    }
  }

  private async processTurn(chatId: string, turn: QueuedFeishuTurn): Promise<void> {
    if (!this.gateway) return;
    const isCurrentTurn = () => this.chatState.isCurrent(chatId, turn.generation);
    if (!isCurrentTurn()) return;
    const reactionId = turn.messageId ? await this.addReaction(turn.messageId) : undefined;
    try {
      let activeRunId: string | undefined;
      let watchdogSettled = false;
      const liveReply = new ImLiveReplyController<FeishuLiveMessageHandle>({
        ...this.liveReplyOptions,
        transport: this.createLiveReplyTransport(chatId),
        onTransportError: (error, phase) => {
          this.logger?.warn?.(`feishu: live reply ${phase} failed: ${error}`);
        },
      });
      const turnTimeoutMs = this.liveReplyOptions?.turnTimeoutMs ?? 600_000;
      const watchdog = turnTimeoutMs > 0
        ? setTimeout(() => {
            if (watchdogSettled) return;
            watchdogSettled = true;
            this.logger?.warn?.(`feishu: live reply timed out for chat ${chatId}`);
            void liveReply.markTimedOut().catch((error: unknown) => {
              this.logger?.warn?.(`feishu: mark timeout failed: ${error}`);
            });
            void this.gateway?.abortTurn({ sessionKey: turn.sessionKey, ...(activeRunId ? { runId: activeRunId } : {}), reason: "system:timeout" })
              .catch((error: unknown) => {
                this.logger?.warn?.(`feishu: abort timeout turn failed: ${error}`);
              });
          }, turnTimeoutMs)
        : undefined;
      watchdog?.unref?.();
      try {
        for await (const event of this.gateway.submitTurn({
          sessionKey: turn.sessionKey,
          channelKey: "feishu",
          message: turn.message,
          ...(turn.attachments.length > 0 ? { attachments: turn.attachments } : {}),
          allowPlanModeTools: false,
          timeoutMs: turnTimeoutMs,
          ...(turn.projectKey ? { projectKey: turn.projectKey } : {}),
        })) {
          if (!isCurrentTurn()) break;
          if (event.type === "turn_started") {
            activeRunId = event.runId;
            this.chatState.setActiveRun(chatId, { sessionKey: turn.sessionKey, runId: activeRunId, generation: turn.generation });
          }
          if (event.type === "elicitation_request") {
            const questionText = this.elicitation.capture(chatId, turn.sessionKey, event);
            await liveReply.pauseActivity();
            await this.send({ chatId, text: questionText });
            continue;
          }
          if (event.type === "permission_request") {
            const questionText = this.permissions.capture(chatId, turn.sessionKey, event);
            await liveReply.pauseActivity();
            if (questionText) await this.send({ chatId, text: questionText });
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
          if (event.type === "assistant_attachment") {
            await liveReply.flushFinal();
            await this.sendAttachment(chatId, event.attachment);
            continue;
          }
          await liveReply.handleEvent(event);
        }
      } catch (e) {
        this.logger?.error?.(`feishu: submitTurn error: ${e}`);
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
              channel: "feishu",
            },
          }),
        });
      } finally {
        watchdogSettled = true;
        if (watchdog) clearTimeout(watchdog);
      }

      this.elicitation.clear(chatId);
      this.permissions.clear(chatId);
      await liveReply.flushFinal();
    } finally {
      if (reactionId && turn.messageId) {
        await this.removeReaction(turn.messageId, reactionId);
      }
      const activeRun = this.chatState.activeRun(chatId);
      if (activeRun?.generation === turn.generation) {
        this.chatState.clearActiveRun(chatId);
      }
    }
  }

  async deliverCronResult(delivery: CronResultDelivery): Promise<boolean> {
    return deliverChatCronResult(delivery, this.channelKey, (chatId, text) =>
      this.sendTextMessage({ chatId, text }),
    );
  }

  private createLiveReplyTransport(chatId: string): ImLiveReplyTransport<FeishuLiveMessageHandle> {
    const liveCursor = this.liveReplyOptions?.cursor ?? DEFAULT_LIVE_REPLY_CURSOR;
    let liveHandle: FeishuLiveMessageHandle | undefined;
    return {
      maxMessageLength: MAX_TEXT_MESSAGE_LENGTH,
      send: async (text) => {
        const result = await this.sendLiveMessage({ chatId, text }, {
          isFinal: !text.endsWith(liveCursor),
          activityKind: this.liveActivityKindFromText(text),
        });
        if (result === false) return false;
        liveHandle = result ? { messageId: result.messageId, livePost: result.livePost } : undefined;
        return liveHandle;
      },
      edit: async (handle, text) => {
        liveHandle = handle;
        return this.editLiveMessage(handle, text, {
          isFinal: !text.endsWith(liveCursor),
          activityKind: this.liveActivityKindFromText(text),
        });
      },
    };
  }

  private async send(message: FeishuOutboundMessage): Promise<void> {
    await this.sendTextMessage(message);
  }

  private async sendAttachment(chatId: string, attachment: Parameters<ImAttachmentDelivery["send"]>[0]): Promise<boolean> {
    return new ImAttachmentDelivery({
      maxBytes: FEISHU_MAX_ATTACHMENT_BYTES,
      logger: this.logger,
      sendTextFallback: (text) => this.send({ chatId, text }),
      sendPrepared: (prepared) => this.uploadAndSendFeishuAttachment(chatId, prepared),
    }).send(attachment);
  }

  private async uploadAndSendFeishuAttachment(chatId: string, prepared: PreparedImAttachment): Promise<void> {
    if (!this.appId || !this.appSecret) throw new Error("feishu app credentials missing");
    if (prepared.fileType === "image") {
      const imageKey = await this.uploadFeishuImage(prepared);
      await this.sendRawMessage(chatId, "image", { image_key: imageKey });
      return;
    }
    const fileKey = await this.uploadFeishuFile(prepared);
    await this.sendRawMessage(chatId, "file", { file_key: fileKey });
  }

  private async uploadFeishuImage(prepared: PreparedImAttachment): Promise<string> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    form.set("image_type", "message");
    form.set("image", new Blob([new Uint8Array(prepared.buffer)], { type: prepared.mimeType ?? "application/octet-stream" }), prepared.name);
    const res = await fetch(FEISHU_IMAGE_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { image_key?: string } };
    if (!res.ok || json.code !== 0 || !json.data?.image_key) {
      if (json.code === 99991663 || json.code === 99991664) this.tokenCache = undefined;
      throw new Error(`feishu image upload failed code=${json.code} msg=${json.msg}`);
    }
    return json.data.image_key;
  }

  private async uploadFeishuFile(prepared: PreparedImAttachment): Promise<string> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    form.set("file_type", inferFeishuFileType(prepared.name, prepared.mimeType));
    form.set("file_name", prepared.name);
    form.set("file", new Blob([new Uint8Array(prepared.buffer)], { type: prepared.mimeType ?? "application/octet-stream" }), prepared.name);
    const res = await fetch(FEISHU_FILE_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { file_key?: string } };
    if (!res.ok || json.code !== 0 || !json.data?.file_key) {
      if (json.code === 99991663 || json.code === 99991664) this.tokenCache = undefined;
      throw new Error(`feishu file upload failed code=${json.code} msg=${json.msg}`);
    }
    return json.data.file_key;
  }

  private async extractIncomingAttachments(input: FeishuInboundMessage): Promise<{
    attachments: ChannelAttachment[];
    diagnostics: string[];
  }> {
    const messageType = input.messageType;
    if (messageType !== "image" && messageType !== "file") {
      if (messageType && !isSupportedFeishuInboundType(messageType)) {
        return { attachments: [], diagnostics: [`[Attachment diagnostics] 飞书 ${messageType} 消息暂不支持附件解析。`] };
      }
      return { attachments: [], diagnostics: [] };
    }
    if (!input.messageId) {
      return { attachments: [], diagnostics: ["[Attachment diagnostics] 飞书附件缺少 message_id，无法下载。"] };
    }

    try {
      const content = parseJsonObject(input.content);
      const token = await this.getTenantAccessToken().catch((error: unknown) => {
        throw new Error(`tenant token unavailable: ${formatError(error)}`);
      });
      if (messageType === "image") {
        const imageKey = readString(content.image_key);
        if (!imageKey) throw new Error("image_key missing");
        const url = `${FEISHU_MESSAGE_RESOURCE_URL}/${encodeURIComponent(input.messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`;
        const attachment = await this.attachmentStore.saveFromUrl({
          url,
          chatId: input.chatId,
          messageId: input.messageId,
          type: "image",
          name: imageKey,
          metadata: { channelKey: "feishu", chatId: input.chatId, messageId: input.messageId, imageKey },
          headers: { Authorization: `Bearer ${token}` },
        });
        return { attachments: [attachment], diagnostics: [] };
      }

      const fileKey = readString(content.file_key);
      if (!fileKey) throw new Error("file_key missing");
      const name = readString(content.file_name) ?? readString(content.name) ?? fileKey;
      const bytes = readNumber(content.size);
      const url = `${FEISHU_MESSAGE_RESOURCE_URL}/${encodeURIComponent(input.messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`;
      const attachment = await this.attachmentStore.saveFromUrl({
        url,
        chatId: input.chatId,
        messageId: input.messageId,
        type: "file",
        name,
        bytes,
        mimeType: guessMimeTypeFromName(name),
        metadata: { channelKey: "feishu", chatId: input.chatId, messageId: input.messageId, fileKey },
        headers: { Authorization: `Bearer ${token}` },
      });
      return { attachments: [attachment], diagnostics: [] };
    } catch (error) {
      this.logger?.warn?.(`feishu: attachment download failed: ${formatError(error)}`);
      return { attachments: [], diagnostics: [`[Attachment diagnostics] 飞书附件下载失败：${formatError(error)}`] };
    }
  }

  private async sendLiveMessage(
    message: FeishuOutboundMessage,
    options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
  ): Promise<FeishuLiveMessageHandle | undefined | false> {
    const messageId = await this.sendPostMessage(message.chatId, message.text, options);
    if (messageId !== false) return { messageId, livePost: true };
    const fallbackMessageId = await this.sendTextMessage(message);
    if (fallbackMessageId === false || fallbackMessageId === undefined) return fallbackMessageId;
    return { messageId: fallbackMessageId, livePost: false };
  }

  private async sendTextMessage(message: FeishuOutboundMessage): Promise<string | undefined | false> {
    if (this.explicitSend) {
      await this.explicitSend(message);
      return undefined;
    }
    return this.sendRawMessage(message.chatId, "text", { text: message.text });
  }

  private async sendRawMessage(chatId: string, msgType: "text" | "image" | "file", content: Record<string, unknown>): Promise<string | undefined | false> {
    if (!this.appId || !this.appSecret) {
      this.logger?.warn?.("feishu: cannot send — appId/appSecret missing");
      return false;
    }

    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(SEND_MESSAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: msgType,
          content: JSON.stringify(content),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.error?.(`feishu: send ${msgType} failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return json.data?.message_id;
    } catch (e) {
      this.logger?.error?.(`feishu: send ${msgType} threw: ${e}`);
    }
    return false;
  }

  private async editLiveMessage(
    handle: FeishuLiveMessageHandle,
    text: string,
    options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
  ): Promise<boolean> {
    if (!handle.messageId || !this.appId || !this.appSecret) return false;
    if (!handle.livePost) return this.editTextMessage(handle.messageId, text);

    const ok = await this.editPostMessage(handle.messageId, text, options);
    if (ok !== false) return true;
    handle.livePost = false;
    return this.editTextMessage(handle.messageId, text);
  }

  private async editTextMessage(messageId: string, text: string): Promise<boolean> {
    if (!messageId || !this.appId || !this.appSecret) return false;

    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(`${UPDATE_MESSAGE_URL}/${encodeURIComponent(messageId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.warn?.(`feishu: update message failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger?.warn?.(`feishu: update message threw: ${e}`);
      return false;
    }
  }

  private async sendPostMessage(
    chatId: string,
    text: string,
    options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
  ): Promise<string | false> {
    if (!this.appId || !this.appSecret) return false;

    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(SEND_MESSAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "post",
          content: JSON.stringify(renderFeishuLivePost(text, options)),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.warn?.(`feishu: send post failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return json.data?.message_id ?? false;
    } catch (e) {
      this.logger?.warn?.(`feishu: send post threw: ${e}`);
      return false;
    }
  }

  private async editPostMessage(
    messageId: string,
    text: string,
    options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
  ): Promise<boolean> {
    if (!messageId || !this.appId || !this.appSecret) return false;

    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(`${UPDATE_MESSAGE_URL}/${encodeURIComponent(messageId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: "post",
          content: JSON.stringify(renderFeishuLivePost(text, options)),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        if (json.code === 99991663 || json.code === 99991664) {
          this.tokenCache = undefined;
        }
        this.logger?.warn?.(`feishu: update post failed code=${json.code} msg=${json.msg}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger?.warn?.(`feishu: update post threw: ${e}`);
      return false;
    }
  }

  private liveActivityKindFromText(text: string): FeishuLiveCardActivityKind {
    if (text.includes("正在执行工具")) return "tool";
    if (text.includes("正在处理子任务")) return "subagent";
    return "thinking";
  }

  private async addReaction(messageId: string): Promise<string | undefined> {
    if (!this.appId || !this.appSecret) return undefined;
    try {
      const token = await this.getTenantAccessToken();
      const res = await fetch(`${REACTION_URL}/${messageId}/reactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reaction_type: { emoji_type: PROCESSING_EMOJI } }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        code?: number;
        data?: { reaction_id?: string };
      };
      if (json.code === 0 && json.data?.reaction_id) {
        return json.data.reaction_id;
      }
      this.logger?.info?.(`feishu: addReaction non-zero code=${json.code}`);
    } catch (e) {
      this.logger?.info?.(`feishu: addReaction failed: ${e}`);
    }
    return undefined;
  }

  private async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!this.appId || !this.appSecret) return;
    try {
      const token = await this.getTenantAccessToken();
      await fetch(`${REACTION_URL}/${messageId}/reactions/${reactionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      this.logger?.info?.(`feishu: removeReaction failed: ${e}`);
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - TOKEN_REFRESH_BUFFER_MS > now) {
      return this.tokenCache.value;
    }
    if (this.tokenInflight) return this.tokenInflight;

    this.tokenInflight = (async () => {
      try {
        const res = await fetch(TENANT_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        });
        const json = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
        if (json.code !== 0 || !json.tenant_access_token) {
          throw new Error(`tenant_access_token failed: code=${json.code} msg=${json.msg}`);
        }
        const expireSec = typeof json.expire === "number" ? json.expire : 7200;
        this.tokenCache = {
          value: json.tenant_access_token,
          expiresAt: Date.now() + expireSec * 1000,
        };
        return this.tokenCache.value;
      } finally {
        this.tokenInflight = undefined;
      }
    })();

    return this.tokenInflight;
  }

  private parseInbound(body: string): ParsedEvent {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return { kind: "ignore" };
    }

    if (typeof raw.encrypt === "string" && this.encryptKey) {
      try {
        const decrypted = decryptFeishuPayload(raw.encrypt, this.encryptKey);
        raw = JSON.parse(decrypted) as Record<string, unknown>;
      } catch (e) {
        this.logger?.error?.(`feishu: decrypt failed: ${e}`);
        return { kind: "ignore" };
      }
    }

    if (raw.type === "url_verification" && typeof raw.challenge === "string") {
      if (this.verifyToken && raw.token !== this.verifyToken) {
        this.logger?.warn?.("feishu: url_verification token mismatch");
      }
      return { kind: "url_verification", challenge: raw.challenge };
    }

    if (this.verifyToken) {
      const token = (raw.token as string | undefined) ?? ((raw.header as { token?: string } | undefined)?.token);
      if (token && token !== this.verifyToken) {
        this.logger?.warn?.("feishu: verifyToken mismatch — ignoring event");
        return { kind: "ignore" };
      }
    }

    const direct = parseDirectShape(raw);
    if (direct) return direct;

    const v2 = parseV2Event(raw);
    if (v2) return v2;

    const v1 = parseV1Event(raw);
    if (v1) return v1;

    return { kind: "ignore" };
  }

  private rememberEvent(eventId: string): void {
    this.seenEvents.add(eventId);
    if (this.seenEvents.size > SEEN_EVENTS_MAX) {
      const first = this.seenEvents.values().next().value;
      if (first) this.seenEvents.delete(first);
    }
  }
}

function parseDirectShape(raw: Record<string, unknown>): ParsedEvent | undefined {
  if (typeof raw.chatId === "string" && typeof raw.text === "string") {
    return {
      kind: "message",
      eventId: typeof raw.eventId === "string" ? raw.eventId : `direct:${raw.chatId}:${Date.now()}`,
      chatId: raw.chatId,
      text: raw.text,
      messageType: "text",
    };
  }
  return undefined;
}

function parseV2Event(raw: Record<string, unknown>): ParsedEvent | undefined {
  const header = raw.header as { event_id?: string; event_type?: string } | undefined;
  const event = raw.event as
    | { message?: { chat_id?: string; content?: string; message_type?: string; message_id?: string } }
    | undefined;

  if (!header?.event_id || !event?.message) return undefined;
  if (header.event_type !== "im.message.receive_v1") return { kind: "ignore" };
  if (!isSupportedFeishuInboundType(event.message.message_type)) return { kind: "ignore" };

  const chatId = event.message.chat_id;
  const content = event.message.content;
  if (!chatId || content === undefined) return undefined;

  const text = extractFeishuMessageText(event.message.message_type, content);
  return {
    kind: "message",
    eventId: header.event_id,
    chatId,
    text,
    messageId: event.message.message_id,
    messageType: event.message.message_type,
    content,
  };
}

function parseV1Event(raw: Record<string, unknown>): ParsedEvent | undefined {
  const event = raw.event as
    | { chat_id?: string; text?: string; type?: string; msg_type?: string; uuid?: string }
    | undefined;
  if (!event?.chat_id || event.text === undefined) return undefined;
  const eventId = (raw.uuid as string | undefined) ?? event.uuid ?? `v1:${event.chat_id}:${Date.now()}`;
  return { kind: "message", eventId, chatId: event.chat_id, text: event.text, messageType: "text" };
}

function isSupportedFeishuInboundType(messageType: string | undefined): boolean {
  return messageType === "text" || messageType === "image" || messageType === "file";
}

function shouldBatchFeishuMessage(input: FeishuInboundMessage): boolean {
  return input.messageType === "image" || input.messageType === "file";
}

function groupFeishuInboundMessages(messages: FeishuInboundMessage[]): FeishuInboundMessage[][] {
  const groups: FeishuInboundMessage[][] = [];
  let attachmentGroup: FeishuInboundMessage[] = [];
  for (const message of messages) {
    if (shouldBatchFeishuMessage(message)) {
      attachmentGroup.push(message);
      continue;
    }
    if (attachmentGroup.length > 0) {
      groups.push(attachmentGroup);
      attachmentGroup = [];
    }
    groups.push([message]);
  }
  if (attachmentGroup.length > 0) groups.push(attachmentGroup);
  return groups;
}

function extractFeishuMessageText(messageType: string | undefined, content: string): string {
  if (messageType !== "text") return "";
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? "";
  } catch {
    return content;
  }
}

function mergeTextAndDiagnostics(text: string, diagnostics: string[]): string {
  if (diagnostics.length === 0) return text;
  return [text.trim(), ...diagnostics].filter(Boolean).join("\n\n");
}

function parseJsonObject(content: string | undefined): Record<string, unknown> {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function inferFeishuFileType(name: string, mimeType: string | undefined): string {
  const lower = name.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "doc";
  if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) return "xls";
  if (lower.endsWith(".ppt") || lower.endsWith(".pptx")) return "ppt";
  return "stream";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}


function renderFeishuLivePost(
  text: string,
  options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
): Record<string, unknown> {
  const content = normalizeLivePostText(text, options);
  return {
    zh_cn: {
      content: [[{ tag: "text", text: content }]],
    },
  };
}

function normalizeLivePostText(
  text: string,
  options: { isFinal: boolean; activityKind?: FeishuLiveCardActivityKind },
): string {
  const stripped = text.replace(/\s*▉\s*$/u, "").trim();
  const body = stripped || (options.isFinal ? "处理完成，但没有可见回复。" : livePostActivityLabel(options.activityKind ?? "thinking"));
  if (body.length <= MAX_TEXT_MESSAGE_LENGTH) return body;
  return `${body.slice(0, Math.max(0, MAX_TEXT_MESSAGE_LENGTH - 12)).trimEnd()}\n…（已截断）`;
}

function livePostActivityLabel(kind: FeishuLiveCardActivityKind): string {
  switch (kind) {
    case "tool":
      return "正在执行工具…";
    case "subagent":
      return "正在处理子任务…";
    case "thinking":
    default:
      return "正在思考…";
  }
}

function decryptFeishuPayload(encrypted: string, key: string): string {
  const aesKey = createHash("sha256").update(key, "utf8").digest();
  const buf = Buffer.from(encrypted, "base64");
  const iv = buf.subarray(0, 16);
  const cipherText = buf.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(true);
  const decoded = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return decoded.toString("utf8");
}

function maskAppId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
