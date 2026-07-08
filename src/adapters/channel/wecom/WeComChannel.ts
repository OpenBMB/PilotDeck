import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelAttachment, Gateway, GatewayChannelKey, GatewayEvent } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { WeComSessionMapper, type WeComSessionMapperScopeInput, type WeComSessionMapperState } from "./WeComSessionMapper.js";
import { renderWeComEvent } from "./wecom-render.js";
import { ImElicitationHelper } from "../protocol/ImElicitationHelper.js";
import { ImPermissionHelper } from "../protocol/ImPermissionHelper.js";
import { executeChannelCommand } from "../protocol/ChannelCommandRegistry.js";
import WebSocket from "ws";

const DEFAULT_WS_URL = "wss://openws.work.weixin.qq.com";
const APP_CMD_SUBSCRIBE = "aibot_subscribe";
const APP_CMD_CALLBACK = "aibot_msg_callback";
const APP_CMD_LEGACY_CALLBACK = "aibot_callback";
const APP_CMD_SEND = "aibot_send_msg";
const APP_CMD_RESPONSE = "aibot_respond_msg";
const APP_CMD_PING = "ping";
const APP_CMD_EVENT_CALLBACK = "aibot_event_callback";
const APP_CMD_UPLOAD_MEDIA_INIT = "aibot_upload_media_init";
const APP_CMD_UPLOAD_MEDIA_CHUNK = "aibot_upload_media_chunk";
const APP_CMD_UPLOAD_MEDIA_FINISH = "aibot_upload_media_finish";
const CALLBACK_COMMANDS = new Set([APP_CMD_CALLBACK, APP_CMD_LEGACY_CALLBACK]);
const NON_RESPONSE_COMMANDS = new Set([...CALLBACK_COMMANDS, APP_CMD_EVENT_CALLBACK]);
const MAX_MESSAGE_LENGTH = 4000;
const CONNECT_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const;
const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX_SIZE = 1000;
const WS_OPEN = 1;
const TEXT_BATCH_DELAY_MS = 600;
const TEXT_BATCH_SPLIT_DELAY_MS = 2_000;
const SPLIT_THRESHOLD = 3_900;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VIDEO_MAX_BYTES = 10 * 1024 * 1024;
const VOICE_MAX_BYTES = 2 * 1024 * 1024;
const FILE_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 512 * 1024;
const MAX_UPLOAD_CHUNKS = 100;
const VOICE_SUPPORTED_MIMES = new Set(["audio/amr"]);
const WECOM_DELIVERABLE_HINT = [
  "",
  "",
  "[WeCom attachment hint: If the user explicitly asks you to send a generated file to this WeCom chat, save it to an absolute local path and include MEDIA:/absolute/path in your final answer. Do not use MEDIA for files that were only read or analyzed internally.]",
].join("");
const DELIVERABLE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg",
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".mp3", ".wav", ".ogg", ".opus", ".m4a", ".flac", ".amr",
  ".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt", ".md",
  ".xlsx", ".xls", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
  ".pptx", ".ppt", ".odp",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z",
  ".html", ".htm",
]);
const DELIVERABLE_EXT_PATTERN = Array.from(DELIVERABLE_EXTENSIONS)
  .map((ext) => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .sort((a, b) => b.length - a.length)
  .join("|");
const MEDIA_TAG_RE = new RegExp(
  "[\"'`]?MEDIA:\\s*(?:`([^`\\n]+)`|\"([^\"\\n]+)\"|'([^'\\n]+)'|((?:~/|/)\\S+))[\"'`]?",
  "gi",
);
const BARE_DELIVERABLE_RE = new RegExp(
  `(^|[\\s(:：])((?:~/|/)[^\\s\`"',;:)\\]}]+?\\.(?:${DELIVERABLE_EXT_PATTERN}))(?=$|[\\s\`"',;:)\\]}])`,
  "gi",
);
const DENIED_BASENAMES = new Set([
  ".env",
  "auth.json",
  "credentials",
  "server-token",
  "pilotdeck.yaml",
]);
const DENIED_SEGMENTS = new Set([
  ".git",
  ".ssh",
  "node_modules",
  "mcp-tokens",
  "pairing",
]);

type WeComAccessPolicy = "open" | "allowlist" | "disabled" | "pairing";
type WeComMediaType = "image" | "video" | "voice" | "file";

type PendingRequest = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type WeComTextBatch = {
  chatId: string;
  chatType: "dm" | "group";
  senderId: string;
  interactionKey: string;
  text: string;
  replyToMessageId: string;
  lastChunkLength: number;
};

type WeComMessageParts = {
  text: string;
  replyText?: string;
  attachments: ChannelAttachment[];
};

type WeComMediaRef = {
  kind: WeComMediaType;
  media: Record<string, unknown>;
};

type PreparedOutboundMedia = {
  data: Buffer;
  contentType: string;
  fileName: string;
  detectedType: WeComMediaType;
  finalType: WeComMediaType;
  rejected: boolean;
  rejectReason?: string;
  downgraded: boolean;
  downgradeNote?: string;
};

type WeComDeliverable = {
  path: string;
  mediaType: WeComMediaType;
};

type WeComDeliverableCandidate = {
  rawPath: string;
  start: number;
  end: number;
};

type WeComDeliverableExtraction = {
  text: string;
  deliverables: WeComDeliverable[];
  warnings: string[];
};

export type WeComChannelOptions = {
  botKey?: string;
  extra?: Record<string, unknown>;
  mapper?: WeComSessionMapper;
  webSocketCtor?: any;
  uuid?: () => string;
  reconnectBackoffMs?: readonly number[];
  onStateChange?: (state: WeComSessionMapperState) => void;
};

export class WeComChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "wecom";

  private readonly mapper: WeComSessionMapper;
  private readonly botId: string;
  private readonly botSecret: string;
  private readonly wsUrl: string;
  private readonly webSocketCtor: any;
  private readonly uuid: () => string;
  private readonly reconnectBackoffMs: readonly number[];
  private readonly deviceId: string;
  private readonly dmPolicy: WeComAccessPolicy;
  private readonly allowFrom: string[];
  private readonly groupPolicy: WeComAccessPolicy;
  private readonly groupAllowFrom: string[];
  private readonly groups: Record<string, unknown>;
  private readonly groupSessionsPerUser: boolean;
  private readonly textBatchDelayMs: number;
  private readonly textBatchSplitDelayMs: number;
  private readonly onStateChange?: (state: WeComSessionMapperState) => void;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private ws: any = null;
  private pending = new Map<string, PendingRequest>();
  private replyReqIds = new Map<string, string>();
  private lastChatReqIds = new Map<string, string>();
  private seenMessages = new Map<string, number>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private intentionalStop = false;
  private activeChats = new Set<string>();
  private pendingTextBatches = new Map<string, WeComTextBatch>();
  private pendingTextBatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly elicitation = new ImElicitationHelper();
  private readonly permissions = new ImPermissionHelper();

  constructor(options: WeComChannelOptions = {}) {
    this.mapper = options.mapper ?? new WeComSessionMapper();
    const ex = options.extra ?? {};
    this.botId = String(
      options.botKey ?? ex.bot_id ?? ex.botId ?? process.env.WECOM_BOT_ID ?? "",
    ).trim();
    this.botSecret = String(
      ex.botSecret ?? ex.secret ?? process.env.WECOM_SECRET ?? "",
    ).trim();
    this.wsUrl = (String(
      ex.websocket_url ?? ex.websocketUrl ?? process.env.WECOM_WEBSOCKET_URL ?? "",
    ).trim() || DEFAULT_WS_URL);
    this.webSocketCtor = options.webSocketCtor ?? WebSocket;
    this.uuid = options.uuid ?? randomUUID;
    this.reconnectBackoffMs = options.reconnectBackoffMs ?? RECONNECT_BACKOFF_MS;
    this.deviceId = this.uuid().replace(/-/g, "");
    this.dmPolicy = normalizePolicy(ex.dm_policy ?? ex.dmPolicy ?? process.env.WECOM_DM_POLICY ?? "pairing");
    this.allowFrom = coerceList(ex.allow_from ?? ex.allowFrom ?? process.env.WECOM_ALLOWED_USERS ?? "");
    this.groupPolicy = normalizePolicy(ex.group_policy ?? ex.groupPolicy ?? process.env.WECOM_GROUP_POLICY ?? "pairing");
    this.groupAllowFrom = coerceList(ex.group_allow_from ?? ex.groupAllowFrom);
    this.groups = isRecord(ex.groups) ? ex.groups : {};
    this.groupSessionsPerUser = typeof ex.group_sessions_per_user === "boolean"
      ? ex.group_sessions_per_user
      : typeof ex.groupSessionsPerUser === "boolean"
        ? ex.groupSessionsPerUser
        : true;
    this.textBatchDelayMs = coerceNonNegativeMs(
      ex.text_batch_delay_ms ?? ex.textBatchDelayMs,
      TEXT_BATCH_DELAY_MS,
    );
    this.textBatchSplitDelayMs = coerceNonNegativeMs(
      ex.text_batch_split_delay_ms ?? ex.textBatchSplitDelayMs,
      TEXT_BATCH_SPLIT_DELAY_MS,
    );
    this.onStateChange = options.onStateChange;
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!this.webSocketCtor) {
      this.logger?.error?.("wecom: `ws` package not installed; run `npm install ws`");
      return { stop: async () => undefined };
    }
    if (!this.botId || !this.botSecret) {
      this.logger?.error?.("wecom: botKey (bot_id) and secret are required");
      return { stop: async () => undefined };
    }

    try {
      this.intentionalStop = false;
      await this.connectWs();
      this.logger?.info?.(`wecom: connected to ${this.wsUrl} as bot ${this.botId}`);
    } catch (e) {
      this.logger?.error?.(`wecom: start failed: ${e}`);
      this.intentionalStop = true;
      this.failPending(new Error("WeCom startup failed"));
      await this.cleanupWs();
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`wecom: stopping (${reason ?? "no reason"})`);
        this.intentionalStop = true;
        this.stopHeartbeat();
        this.clearReconnectTimer();
        this.failPending(new Error("WeCom adapter stopped"));
        this.replyReqIds.clear();
        this.lastChatReqIds.clear();
        this.seenMessages.clear();
        this.clearTextBatches();
        await this.cleanupWs();
      },
    };
  }

  private async connectWs(): Promise<void> {
    await this.cleanupWs();
    this.ws = new this.webSocketCtor(this.wsUrl);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WeCom WebSocket connect timeout")), CONNECT_TIMEOUT_MS);
      this.ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.once("error", (err: unknown) => {
        clearTimeout(t);
        reject(err);
      });
    });

    this.ws.on("message", (data: any) => {
      void this.onSocketData(data.toString()).catch((e: unknown) => {
        this.logger?.error?.(`wecom: message handling failed: ${e}`);
      });
    });
    this.ws.on("close", () => {
      this.stopHeartbeat();
      this.failPending(new Error("WeCom connection interrupted"));
      if (!this.intentionalStop) {
        this.logger?.warn?.("wecom: WebSocket closed");
        this.scheduleReconnect();
      }
    });
    this.ws.on("error", (err: unknown) => {
      this.logger?.error?.(`wecom: WebSocket error: ${err}`);
    });

    const reqId = this.newReqId("subscribe");
    const authPromise = this.waitForReq(reqId, CONNECT_TIMEOUT_MS);
    await this.sendJson({
      cmd: APP_CMD_SUBSCRIBE,
      headers: { req_id: reqId },
      body: { bot_id: this.botId, secret: this.botSecret, device_id: this.deviceId },
    });

    const auth = await authPromise;
    const body = (auth as { body?: { errcode?: number; errmsg?: string } }).body;
    const errcode = body?.errcode ?? (auth as { errcode?: number }).errcode;
    if (errcode != null && errcode !== 0) {
      const errmsg = body?.errmsg ?? (auth as { errmsg?: string }).errmsg ?? "auth failed";
      throw new Error(`${errmsg} (errcode=${errcode})`);
    }

    this.reconnectAttempt = 0;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendPingFrame();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async cleanupWs(): Promise<void> {
    if (this.ws) {
      try { this.ws.close(); } catch { /* best effort */ }
      this.ws = null;
    }
  }

  private newReqId(prefix: string): string {
    return `${prefix}-${this.uuid().replace(/-/g, "")}`;
  }

  private payloadReqId(payload: Record<string, unknown>): string {
    const h = payload.headers as Record<string, unknown> | undefined;
    return String(h?.req_id ?? "");
  }

  private async sendJson(payload: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error("WeCom websocket is not connected");
    }
    this.ws.send(JSON.stringify(payload));
  }

  private async waitForReq(reqId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("Timeout waiting for WeCom response"));
      }, timeoutMs);
      t.unref?.();
      this.pending.set(reqId, {
        resolve: (p) => {
          clearTimeout(t);
          this.pending.delete(reqId);
          resolve(p);
        },
        reject: (error) => {
          clearTimeout(t);
          this.pending.delete(reqId);
          reject(error);
        },
        timeout: t,
      });
    });
  }

  private failPending(error: Error): void {
    for (const [reqId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(reqId);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTextBatches(): void {
    for (const timer of this.pendingTextBatchTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTextBatchTimers.clear();
    this.pendingTextBatches.clear();
  }

  private scheduleReconnect(): void {
    if (this.intentionalStop || this.reconnectTimer) return;
    const delay = this.reconnectBackoffMs[Math.min(this.reconnectAttempt, this.reconnectBackoffMs.length - 1)] ?? 60_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectWs()
        .then(() => {
          this.logger?.info?.("wecom: reconnected");
        })
        .catch((e: unknown) => {
          this.logger?.warn?.(`wecom: reconnect failed: ${e}`);
          void this.cleanupWs().finally(() => this.scheduleReconnect());
        });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private settlePending(reqId: string, payload: Record<string, unknown>): boolean {
    const pending = this.pending.get(reqId);
    if (!pending) return false;
    pending.resolve(payload);
    return true;
  }

  private isDuplicateMessage(messageId: string): boolean {
    const now = Date.now();
    for (const [id, seenAt] of this.seenMessages.entries()) {
      if (now - seenAt > DEDUP_TTL_MS) {
        this.seenMessages.delete(id);
      }
    }
    if (this.seenMessages.has(messageId)) return true;
    this.seenMessages.set(messageId, now);
    while (this.seenMessages.size > DEDUP_MAX_SIZE) {
      const first = this.seenMessages.keys().next().value;
      if (!first) break;
      this.seenMessages.delete(first);
    }
    return false;
  }

  private rememberReplyReqId(messageId: string, reqId: string): void {
    const mid = messageId.trim();
    const rid = reqId.trim();
    if (!mid || !rid) return;
    this.replyReqIds.set(mid, rid);
    trimMap(this.replyReqIds, DEDUP_MAX_SIZE);
  }

  private rememberChatReqId(chatId: string, reqId: string): void {
    const cid = chatId.trim();
    const rid = reqId.trim();
    if (!cid || !rid) return;
    this.lastChatReqIds.set(cid, rid);
    trimMap(this.lastChatReqIds, DEDUP_MAX_SIZE);
  }

  private interactionKey(chatId: string, userId: string, chatType: "dm" | "group"): string {
    if (chatType === "group" && this.groupSessionsPerUser && userId) {
      return `${chatId}:${userId}`;
    }
    return chatId;
  }

  private stripLeadingMention(text: string): string {
    return text.replace(/^@\S+\s*/, "").trim();
  }

  private isDmAllowed(senderId: string): boolean {
    if (!senderId) return false;
    if (this.dmPolicy === "disabled") return false;
    if (this.dmPolicy === "allowlist") return entryMatches(this.allowFrom, senderId);
    if (this.dmPolicy === "open") return true;
    this.logger?.warn?.("wecom: dm_policy=pairing is not supported in PilotDeck; DM ignored");
    return false;
  }

  private isGroupAllowed(chatId: string, senderId: string): boolean {
    if (!chatId) return false;
    if (this.groupPolicy === "disabled") return false;
    if (this.groupPolicy === "pairing") {
      this.logger?.warn?.("wecom: group_policy=pairing is not supported in PilotDeck; group message ignored");
      return false;
    }
    if (this.groupPolicy === "allowlist" && !entryMatches(this.groupAllowFrom, chatId)) {
      return false;
    }

    const groupCfg = this.resolveGroupConfig(chatId);
    const senderAllow = coerceList(groupCfg.allow_from ?? groupCfg.allowFrom);
    if (senderAllow.length > 0) {
      return entryMatches(senderAllow, senderId);
    }
    return true;
  }

  private resolveGroupConfig(chatId: string): Record<string, unknown> {
    const exact = this.groups[chatId];
    if (isRecord(exact)) return exact;
    const lowered = chatId.toLowerCase();
    for (const [key, value] of Object.entries(this.groups)) {
      if (key.toLowerCase() === lowered && isRecord(value)) return value;
    }
    const wildcard = this.groups["*"];
    return isRecord(wildcard) ? wildcard : {};
  }

  private async handleCommandIfNeeded(
    text: string,
    chatId: string,
    senderId: string,
    chatType: "dm" | "group",
    messageId: string,
  ): Promise<boolean> {
    if (!this.gateway || !text.trim().startsWith("/")) return false;
    const scopeInput: WeComSessionMapperScopeInput = {
      chatId,
      userId: senderId,
      chatType,
      groupSessionsPerUser: this.groupSessionsPerUser,
    };
    return executeChannelCommand(text, {
      gateway: this.gateway,
      chatId,
      channelKey: "wecom",
      reply: (msg) => this.sendReply(chatId, msg, { chatType, replyToMessageId: messageId }),
      bindProject: (projectKey) => { this.mapper.bindProject(scopeInput, projectKey); this.onStateChange?.(this.mapper.snapshot()); },
      getProject: () => this.mapper.getProject(scopeInput),
      resetSession: () => { this.mapper.resolve({ ...scopeInput, text: "/new" }); this.onStateChange?.(this.mapper.snapshot()); },
      logger: this.logger,
    });
  }

  private async onSocketData(raw: string): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const reqId = this.payloadReqId(payload);
    const cmd = String(payload.cmd ?? "");

    if (reqId && !NON_RESPONSE_COMMANDS.has(cmd) && this.settlePending(reqId, payload)) {
      return;
    }

    if (CALLBACK_COMMANDS.has(cmd)) {
      await this.onBotCallback(payload);
    }
  }

  private async onBotCallback(payload: Record<string, unknown>): Promise<void> {
    const body = payload.body as Record<string, unknown> | undefined;
    if (!body) return;

    const inboundReq = this.payloadReqId(payload);
    const messageId = String(body.msgid ?? inboundReq ?? this.uuid()).trim();
    if (this.isDuplicateMessage(messageId)) {
      this.logger?.info?.(`wecom: duplicate message ${messageId} ignored`);
      return;
    }

    const sender = (body.from as Record<string, unknown> | undefined) ?? {};
    const senderId = String(sender.userid ?? "").trim();
    const chatId = String(body.chatid ?? senderId).trim();
    if (!chatId) return;

    const chatType = String(body.chattype ?? "").toLowerCase() === "group" ? "group" : "dm";
    if (chatType === "group") {
      if (!this.isGroupAllowed(chatId, senderId)) return;
    } else if (!this.isDmAllowed(senderId)) {
      return;
    }

    if (inboundReq) {
      this.rememberReplyReqId(messageId, inboundReq);
      this.rememberChatReqId(chatId, inboundReq);
    }

    const parts = await this.extractMessageParts(body);
    const extractedText = parts.text || parts.replyText || "";
    const text = chatType === "group" ? this.stripLeadingMention(extractedText) : extractedText;
    if (!text.trim() && parts.attachments.length === 0) return;

    const interactionKey = this.interactionKey(chatId, senderId, chatType);
    if (this.elicitation.hasPending(interactionKey) && this.gateway) {
      try {
        const confirmation = await this.elicitation.answer(interactionKey, text, this.gateway);
        if (confirmation) await this.sendReply(chatId, confirmation, { chatType, replyToMessageId: messageId });
      } catch (e) {
        this.logger?.error?.(`wecom: elicitation answer error: ${e}`);
      }
      return;
    }

    if (this.permissions.hasPending(interactionKey) && this.gateway) {
      try {
        const confirmation = await this.permissions.answer(interactionKey, text, this.gateway);
        if (confirmation) await this.sendReply(chatId, confirmation, { chatType, replyToMessageId: messageId });
      } catch (e) {
        this.logger?.error?.(`wecom: permission answer error: ${e}`);
      }
      return;
    }

    if (text.trim().startsWith("/")) {
      await this.dispatchTextMessage({
        chatId,
        chatType,
        senderId,
        interactionKey,
        text,
        attachments: parts.attachments,
        replyToMessageId: messageId,
      });
      return;
    }

    if (parts.attachments.length > 0) {
      await this.dispatchTextMessage({
        chatId,
        chatType,
        senderId,
        interactionKey,
        text: text || "用户发送了企业微信附件。",
        attachments: parts.attachments,
        replyToMessageId: messageId,
      });
      return;
    }

    this.enqueueTextBatch({
      chatId,
      chatType,
      senderId,
      interactionKey,
      text,
      replyToMessageId: messageId,
      lastChunkLength: text.length,
    });
  }

  private enqueueTextBatch(batch: WeComTextBatch): void {
    if (this.textBatchDelayMs <= 0) {
      void this.dispatchTextMessage(batch);
      return;
    }

    const existing = this.pendingTextBatches.get(batch.interactionKey);
    if (existing) {
      existing.text = existing.text ? `${existing.text}\n${batch.text}` : batch.text;
      existing.replyToMessageId = batch.replyToMessageId;
      existing.lastChunkLength = batch.lastChunkLength;
    } else {
      this.pendingTextBatches.set(batch.interactionKey, { ...batch });
    }

    const priorTimer = this.pendingTextBatchTimers.get(batch.interactionKey);
    if (priorTimer) clearTimeout(priorTimer);

    const delay = batch.lastChunkLength >= SPLIT_THRESHOLD
      ? this.textBatchSplitDelayMs
      : this.textBatchDelayMs;
    const timer = setTimeout(() => {
      if (this.pendingTextBatchTimers.get(batch.interactionKey) !== timer) return;
      this.pendingTextBatchTimers.delete(batch.interactionKey);
      void this.flushTextBatch(batch.interactionKey);
    }, delay);
    timer.unref?.();
    this.pendingTextBatchTimers.set(batch.interactionKey, timer);
  }

  private async flushTextBatch(interactionKey: string): Promise<void> {
    const batch = this.pendingTextBatches.get(interactionKey);
    if (!batch) return;
    this.pendingTextBatches.delete(interactionKey);
    this.logger?.info?.(`wecom: flushing text batch ${interactionKey} (${batch.text.length} chars)`);
    await this.dispatchTextMessage(batch);
  }

  private async dispatchTextMessage(input: {
    chatId: string;
    chatType: "dm" | "group";
    senderId: string;
    interactionKey: string;
    text: string;
    attachments?: ChannelAttachment[];
    replyToMessageId: string;
  }): Promise<void> {
    const mapped = this.mapper.resolve({
      chatId: input.chatId,
      text: input.text,
      userId: input.senderId,
      chatType: input.chatType,
      groupSessionsPerUser: this.groupSessionsPerUser,
    });
    if (mapped.command === "new") {
      this.onStateChange?.(this.mapper.snapshot());
    }
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(input.chatId, "已创建新会话。", {
        chatType: input.chatType,
        replyToMessageId: input.replyToMessageId,
      });
      return;
    }

    if (await this.handleCommandIfNeeded(input.text, input.chatId, input.senderId, input.chatType, input.replyToMessageId)) {
      return;
    }
    if (!mapped.message) return;

    if (this.activeChats.has(mapped.sessionKey)) {
      this.logger?.info?.(`wecom: session ${mapped.sessionKey} already active, skipping`);
      return;
    }

    this.activeChats.add(mapped.sessionKey);
    try {
      await this.processMessage({
        chatId: input.chatId,
        chatType: input.chatType,
        interactionKey: input.interactionKey,
        sessionKey: mapped.sessionKey,
        projectKey: mapped.projectKey,
        message: mapped.message,
        attachments: input.attachments,
        replyToMessageId: input.replyToMessageId,
      });
    } finally {
      this.activeChats.delete(mapped.sessionKey);
    }
  }

  private async extractMessageParts(body: Record<string, unknown>): Promise<WeComMessageParts> {
    const textParts: string[] = [];
    const attachments: ChannelAttachment[] = [];
    const msgtype = String(body.msgtype ?? "").toLowerCase();

    if (msgtype === "mixed") {
      const mixed = (body.mixed as Record<string, unknown> | undefined) ?? {};
      const items = (mixed.msg_item as unknown[]) ?? [];
      for (const item of items) {
        if (!isRecord(item)) continue;
        if (String(item.msgtype ?? "").toLowerCase() === "text") {
          const tb = (item.text as Record<string, unknown> | undefined) ?? {};
          const c = String(tb.content ?? "").trim();
          if (c) textParts.push(c);
        }
      }
    } else {
      const tb = (body.text as Record<string, unknown> | undefined) ?? {};
      const c = String(tb.content ?? "").trim();
      if (c) textParts.push(c);

      if (msgtype === "voice") {
        const voice = (body.voice as Record<string, unknown> | undefined) ?? {};
        const voiceText = String(voice.content ?? "").trim();
        if (voiceText) textParts.push(voiceText);
      }

      if (msgtype === "appmsg") {
        const appmsg = (body.appmsg as Record<string, unknown> | undefined) ?? {};
        const title = String(appmsg.title ?? "").trim();
        if (title) textParts.push(title);
      }
    }

    const quote = (body.quote as Record<string, unknown> | undefined) ?? {};
    let replyText: string | undefined;
    const quoteType = String(quote.msgtype ?? "").toLowerCase();
    if (quoteType === "text") {
      const quoteText = (quote.text as Record<string, unknown> | undefined) ?? {};
      replyText = String(quoteText.content ?? "").trim() || undefined;
    } else if (quoteType === "voice") {
      const quoteVoice = (quote.voice as Record<string, unknown> | undefined) ?? {};
      replyText = String(quoteVoice.content ?? "").trim() || undefined;
    }

    for (const ref of this.extractMediaRefs(body)) {
      const cached = await this.cacheInboundMedia(ref.kind, ref.media);
      if (cached) attachments.push(cached);
    }

    return { text: textParts.join("\n").trim(), replyText, attachments };
  }

  private extractMediaRefs(body: Record<string, unknown>): WeComMediaRef[] {
    const refs: WeComMediaRef[] = [];
    const msgtype = String(body.msgtype ?? "").toLowerCase();

    const addMedia = (kind: WeComMediaType, value: unknown) => {
      if (isRecord(value)) refs.push({ kind, media: value });
    };

    if (msgtype === "mixed") {
      const mixed = (body.mixed as Record<string, unknown> | undefined) ?? {};
      const items = (mixed.msg_item as unknown[]) ?? [];
      for (const item of items) {
        if (!isRecord(item)) continue;
        const itemType = String(item.msgtype ?? "").toLowerCase();
        if (itemType === "image") addMedia("image", item.image);
        if (itemType === "file") addMedia("file", item.file);
      }
    } else {
      addMedia("image", body.image);
      if (msgtype === "file") addMedia("file", body.file);
      if (msgtype === "voice") addMedia("voice", body.voice);
      if (msgtype === "video") addMedia("video", body.video);
      if (msgtype === "appmsg" && isRecord(body.appmsg)) {
        addMedia("file", body.appmsg.file);
        addMedia("image", body.appmsg.image);
      }
    }

    const quote = (body.quote as Record<string, unknown> | undefined) ?? {};
    const quoteType = String(quote.msgtype ?? "").toLowerCase();
    if (quoteType === "image") addMedia("image", quote.image);
    if (quoteType === "file") addMedia("file", quote.file);

    return refs;
  }

  private async cacheInboundMedia(kind: WeComMediaType, media: Record<string, unknown>): Promise<ChannelAttachment | undefined> {
    let data: Buffer | undefined;
    if (media.base64) {
      try {
        data = Buffer.from(String(media.base64), "base64");
      } catch (e) {
        this.logger?.warn?.(`wecom: failed to decode inbound ${kind} base64: ${e}`);
        return undefined;
      }
    } else {
      const url = String(media.url ?? "").trim();
      if (!url) return undefined;
      try {
        const downloaded = await this.downloadRemoteBytes(url, FILE_MAX_BYTES);
        data = downloaded.data;
      } catch (e) {
        this.logger?.warn?.(`wecom: failed to download inbound ${kind}: ${e}`);
        return undefined;
      }
    }

    const aesKey = String(media.aeskey ?? "").trim();
    if (aesKey) {
      try {
        data = decryptWeComBytes(data, aesKey);
      } catch (e) {
        this.logger?.warn?.(`wecom: failed to decrypt inbound ${kind}: ${e}`);
        return undefined;
      }
    }

    const rawName = String(media.filename ?? media.name ?? `wecom_${kind}${defaultExtForMedia(kind)}`).trim();
    const safeName = safeFileName(rawName || `wecom_${kind}${defaultExtForMedia(kind)}`);
    const dir = join(tmpdir(), "pilotdeck-wecom-media");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${Date.now()}-${this.uuid().replace(/-/g, "")}-${safeName}`);
    await writeFile(filePath, data, { mode: 0o600 });
    const mimeType = normalizeContentType(String(media.content_type ?? media.contentType ?? ""), safeName);
    const attachmentType = kind === "image" ? "image" : "file";
    return {
      type: attachmentType,
      name: safeName,
      path: filePath,
      mimeType,
      bytes: data.length,
      metadata: { source: "wecom", mediaType: kind },
    };
  }

  private async processMessage(input: {
    chatId: string;
    chatType: "dm" | "group";
    interactionKey: string;
    sessionKey: string;
    projectKey?: string;
    message: string;
    attachments?: ChannelAttachment[];
    replyToMessageId: string;
  }): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey: input.sessionKey,
        channelKey: "wecom",
        message: input.message,
        attachments: input.attachments,
        allowPlanModeTools: false,
        syntheticMessages: [{ text: WECOM_DELIVERABLE_HINT.trim(), purpose: "wecom_deliverable_hint" }],
        ...(input.projectKey ? { projectKey: input.projectKey } : {}),
      })) {
        if (event.type === "elicitation_request") {
          const questionText = this.elicitation.capture(input.interactionKey, input.sessionKey, event);
          await this.sendReply(input.chatId, questionText, {
            chatType: input.chatType,
            replyToMessageId: input.replyToMessageId,
          });
          continue;
        }
        if (event.type === "permission_request") {
          const questionText = this.permissions.capture(input.interactionKey, input.sessionKey, event);
          if (questionText) await this.sendReply(input.chatId, questionText, {
            chatType: input.chatType,
            replyToMessageId: input.replyToMessageId,
          });
          continue;
        }
        await this.sendEventMedia(input.chatId, event, {
          chatType: input.chatType,
          replyToMessageId: input.replyToMessageId,
        });
        const fragment = renderWeComEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`wecom: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    this.elicitation.clear(input.interactionKey);
    this.permissions.clear(input.interactionKey);
    const finalText = replyText.trim();
    if (!finalText) return;

    const context = {
      chatType: input.chatType,
      replyToMessageId: input.replyToMessageId,
    };
    const delivery = await extractWeComDeliverables(finalText);
    const visibleParts = [delivery.text, ...delivery.warnings].map((part) => part.trim()).filter(Boolean);
    const visibleText = visibleParts.join("\n");
    if (visibleText) {
      await this.sendReply(input.chatId, visibleText, context);
    } else if (delivery.deliverables.length > 0) {
      await this.sendReply(input.chatId, "我已生成附件，正在发送。", context);
    }

    for (const deliverable of delivery.deliverables) {
      await this.sendDeliverable(input.chatId, deliverable, context);
    }
  }

  private async sendReply(
    chatId: string,
    text: string,
    context: { chatType?: "dm" | "group"; replyToMessageId?: string } = {},
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      this.logger?.warn?.(`wecom: not connected, cannot send to ${chatId}`);
      return;
    }

    const slice = text.slice(0, MAX_MESSAGE_LENGTH);
    const replyReq = this.replyReqIdFor(chatId, context.replyToMessageId);

    try {
      const response = replyReq
        ? await this.sendMarkdownByReqId(replyReq, slice)
        : context.chatType === "group"
          ? undefined
          : await this.sendProactiveMarkdown(chatId, slice);

      if (!response) {
        this.logger?.warn?.(`wecom: no reply request id for group chat ${chatId}, cannot send proactive message`);
        return;
      }

      const err = this.responseError(response);
      if (err) {
        this.logger?.error?.(`wecom: sendReply error: ${err}`);
      }
    } catch (e) {
      this.logger?.error?.(`wecom: sendReply failed: ${e}`);
    }
  }

  private async sendEventMedia(
    chatId: string,
    event: GatewayEvent,
    context: { chatType?: "dm" | "group"; replyToMessageId?: string },
  ): Promise<void> {
    if (event.type !== "tool_call_finished" || !event.images?.length) return;

    for (const [index, image] of event.images.entries()) {
      try {
        const data = Buffer.from(image.data, "base64");
        const prepared = this.prepareOutboundMediaBytes(
          data,
          image.mimeType,
          `tool-${event.toolCallId || "image"}-${index + 1}${extForMime(image.mimeType) || ".png"}`,
        );
        const ok = await this.sendPreparedMedia(chatId, prepared, context);
        if (!ok) {
          await this.sendReply(chatId, "图片结果生成成功，但发送到企业微信失败。", context);
        }
      } catch (e) {
        this.logger?.error?.(`wecom: failed to send inline image result: ${e}`);
        await this.sendReply(chatId, "图片结果生成成功，但发送到企业微信失败。", context);
      }
    }
  }

  async sendImage(chatId: string, imageSource: string, caption?: string, replyTo?: string): Promise<boolean> {
    return this.sendMediaSource(chatId, imageSource, { caption, replyTo });
  }

  async sendImageFile(chatId: string, imagePath: string, caption?: string, replyTo?: string): Promise<boolean> {
    return this.sendImage(chatId, imagePath, caption, replyTo);
  }

  async sendDocument(chatId: string, filePath: string, caption?: string, fileName?: string, replyTo?: string): Promise<boolean> {
    return this.sendMediaSource(chatId, filePath, { caption, fileName, replyTo, forceType: "file" });
  }

  async sendVoice(chatId: string, audioPath: string, caption?: string, replyTo?: string): Promise<boolean> {
    return this.sendMediaSource(chatId, audioPath, { caption, replyTo });
  }

  async sendVideo(chatId: string, videoPath: string, caption?: string, replyTo?: string): Promise<boolean> {
    return this.sendMediaSource(chatId, videoPath, { caption, replyTo });
  }

  private async sendDeliverable(
    chatId: string,
    deliverable: WeComDeliverable,
    context: { chatType?: "dm" | "group"; replyToMessageId?: string },
  ): Promise<boolean> {
    const replyTo = context.replyToMessageId;
    switch (deliverable.mediaType) {
      case "image":
        return this.sendMediaSource(chatId, deliverable.path, { replyTo });
      case "video":
        return this.sendMediaSource(chatId, deliverable.path, { replyTo });
      case "voice":
        return this.sendMediaSource(chatId, deliverable.path, { replyTo });
      case "file":
        return this.sendMediaSource(chatId, deliverable.path, { replyTo, forceType: "file" });
    }
  }

  private async sendMediaSource(
    chatId: string,
    source: string,
    options: { caption?: string; fileName?: string; replyTo?: string; forceType?: WeComMediaType } = {},
  ): Promise<boolean> {
    if (!chatId) return false;
    try {
      const prepared = await this.loadOutboundMediaSource(source, options.fileName);
      const finalPrepared = options.forceType
        ? { ...prepared, finalType: options.forceType, detectedType: options.forceType }
        : prepared;
      const context = { replyToMessageId: options.replyTo };
      const ok = await this.sendPreparedMedia(chatId, finalPrepared, context);
      if (ok && options.caption) await this.sendReply(chatId, options.caption, context);
      return ok;
    } catch (e) {
      this.logger?.error?.(`wecom: send media source failed: ${e}`);
      return false;
    }
  }

  private prepareOutboundMediaBytes(data: Buffer, contentType: string, fileName: string): PreparedOutboundMedia {
    const normalizedContentType = normalizeContentType(contentType, fileName);
    const detectedType = detectWeComMediaType(normalizedContentType);
    const sizeCheck = applyMediaSizeLimits(data.length, detectedType, normalizedContentType);
    return {
      data,
      contentType: normalizedContentType,
      fileName: safeFileName(fileName || `wecom_media${defaultExtForMedia(detectedType)}`),
      detectedType,
      ...sizeCheck,
    };
  }

  private async loadOutboundMediaSource(source: string, fileName?: string): Promise<PreparedOutboundMedia> {
    const trimmed = source.trim();
    if (!trimmed) throw new Error("media source is required");
    let data: Buffer;
    let resolvedName = fileName;
    let contentType = "";

    const parsed = tryParseUrl(trimmed);
    if (parsed?.protocol === "file:") {
      const path = fileURLToPath(parsed);
      data = await readFile(path);
      resolvedName ??= basename(path);
    } else if (parsed?.protocol === "http:" || parsed?.protocol === "https:") {
      const downloaded = await this.downloadRemoteBytes(trimmed, FILE_MAX_BYTES);
      data = downloaded.data;
      contentType = downloaded.contentType;
      resolvedName ??= guessFileName(trimmed, downloaded.contentDisposition);
    } else {
      const path = resolve(trimmed);
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`media source is not a file: ${path}`);
      data = await readFile(path);
      resolvedName ??= basename(path);
    }

    return this.prepareOutboundMediaBytes(data, contentType, resolvedName ?? "wecom_media");
  }

  private async sendPreparedMedia(
    chatId: string,
    prepared: PreparedOutboundMedia,
    context: { chatType?: "dm" | "group"; replyToMessageId?: string } = {},
  ): Promise<boolean> {
    if (prepared.rejected) {
      await this.sendReply(chatId, prepared.rejectReason ?? "企业微信媒体文件过大，无法发送。", context);
      return false;
    }

    try {
      const upload = await this.uploadMediaBytes(prepared.data, prepared.finalType, prepared.fileName);
      const mediaId = String(upload.media_id ?? upload.mediaId ?? "").trim();
      if (!mediaId) throw new Error("media upload did not return media_id");

      const replyReq = this.replyReqIdFor(chatId, context.replyToMessageId);
      const response = replyReq
        ? await this.sendReplyMediaMessage(replyReq, prepared.finalType, mediaId)
        : context.chatType === "group"
          ? undefined
          : await this.sendMediaMessage(chatId, prepared.finalType, mediaId);

      if (!response) {
        this.logger?.warn?.(`wecom: no reply request id for group media ${chatId}, cannot send proactive message`);
        return false;
      }
      const err = this.responseError(response);
      if (err) {
        this.logger?.error?.(`wecom: send media error: ${err}`);
        return false;
      }
      if (prepared.downgraded && prepared.downgradeNote) {
        await this.sendReply(chatId, prepared.downgradeNote, context);
      }
      return true;
    } catch (e) {
      this.logger?.error?.(`wecom: send media failed: ${e}`);
      return false;
    }
  }

  private async uploadMediaBytes(data: Buffer, mediaType: WeComMediaType, filename: string): Promise<Record<string, unknown>> {
    if (data.length === 0) throw new Error("Cannot upload empty media");
    const totalChunks = Math.ceil(data.length / UPLOAD_CHUNK_SIZE);
    if (totalChunks > MAX_UPLOAD_CHUNKS) {
      throw new Error(`File too large: ${totalChunks} chunks exceeds maximum of ${MAX_UPLOAD_CHUNKS}`);
    }

    const initResponse = await this.sendRequest(APP_CMD_UPLOAD_MEDIA_INIT, {
      type: mediaType,
      filename,
      total_size: data.length,
      total_chunks: totalChunks,
      md5: createHash("md5").update(data).digest("hex"),
    });
    const initErr = this.responseError(initResponse);
    if (initErr) throw new Error(`media upload init failed: ${initErr}`);
    const initBody = (initResponse.body as Record<string, unknown> | undefined) ?? {};
    const uploadId = String(initBody.upload_id ?? initBody.uploadId ?? "").trim();
    if (!uploadId) throw new Error("media upload init failed: missing upload_id");

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * UPLOAD_CHUNK_SIZE;
      const chunk = data.subarray(start, start + UPLOAD_CHUNK_SIZE);
      const chunkResponse = await this.sendRequest(APP_CMD_UPLOAD_MEDIA_CHUNK, {
        upload_id: uploadId,
        chunk_index: chunkIndex,
        base64_data: chunk.toString("base64"),
      });
      const chunkErr = this.responseError(chunkResponse);
      if (chunkErr) throw new Error(`media upload chunk ${chunkIndex} failed: ${chunkErr}`);
    }

    const finishResponse = await this.sendRequest(APP_CMD_UPLOAD_MEDIA_FINISH, { upload_id: uploadId });
    const finishErr = this.responseError(finishResponse);
    if (finishErr) throw new Error(`media upload finish failed: ${finishErr}`);
    const finishBody = (finishResponse.body as Record<string, unknown> | undefined) ?? {};
    return { ...finishResponse, ...finishBody };
  }

  private async downloadRemoteBytes(url: string, maxBytes: number): Promise<{
    data: Buffer;
    contentType: string;
    contentDisposition?: string;
  }> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported media URL protocol: ${parsed.protocol}`);
    }
    const response = await fetch(url, {
      headers: { "User-Agent": "PilotDeck/1.0", "Accept": "*/*" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      throw new Error(`remote media exceeds limit: ${contentLength} bytes > ${maxBytes}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`remote media exceeds limit: ${bytes.length} bytes > ${maxBytes}`);
    return {
      data: bytes,
      contentType: response.headers.get("content-type") ?? "",
      contentDisposition: response.headers.get("content-disposition") ?? undefined,
    };
  }

  private async sendMarkdownByReqId(reqId: string, text: string): Promise<Record<string, unknown>> {
    return this.sendReplyRequest(reqId, {
      msgtype: "markdown",
      markdown: { content: text.slice(0, MAX_MESSAGE_LENGTH) },
    });
  }

  private async sendProactiveMarkdown(chatId: string, text: string): Promise<Record<string, unknown>> {
    return this.sendRequest(APP_CMD_SEND, {
      chatid: chatId,
      msgtype: "markdown",
      markdown: { content: text.slice(0, MAX_MESSAGE_LENGTH) },
    });
  }

  private async sendReplyMediaMessage(
    reqId: string,
    mediaType: WeComMediaType,
    mediaId: string,
  ): Promise<Record<string, unknown>> {
    return this.sendReplyRequest(reqId, {
      msgtype: mediaType,
      [mediaType]: { media_id: mediaId },
    });
  }

  private async sendMediaMessage(
    chatId: string,
    mediaType: WeComMediaType,
    mediaId: string,
  ): Promise<Record<string, unknown>> {
    return this.sendRequest(APP_CMD_SEND, {
      chatid: chatId,
      msgtype: mediaType,
      [mediaType]: { media_id: mediaId },
    });
  }

  private async sendRequest(cmd: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reqId = this.newReqId(cmd);
    const promise = this.waitForReq(reqId, REQUEST_TIMEOUT_MS);
    await this.sendJson({ cmd, headers: { req_id: reqId }, body });
    return promise;
  }

  private async sendReplyRequest(
    replyReqId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const rid = String(replyReqId).trim();
    if (!rid) throw new Error("reply_req_id is required");
    const promise = this.waitForReq(rid, REQUEST_TIMEOUT_MS);
    await this.sendJson({ cmd: APP_CMD_RESPONSE, headers: { req_id: rid }, body });
    return promise;
  }

  private async sendPingFrame(): Promise<void> {
    try {
      await this.sendJson({
        cmd: APP_CMD_PING,
        headers: { req_id: this.newReqId("ping") },
        body: {},
      });
    } catch {
      // Best effort heartbeat; close/error handlers drive reconnects.
    }
  }

  private replyReqIdFor(chatId: string, replyToMessageId?: string): string | undefined {
    if (replyToMessageId) {
      const reqId = this.replyReqIds.get(replyToMessageId);
      if (reqId) return reqId;
    }
    return this.lastChatReqIds.get(chatId);
  }

  private responseError(res: Record<string, unknown>): string | undefined {
    const body = res.body as Record<string, unknown> | undefined;
    const errcode = body?.errcode ?? (res as { errcode?: unknown }).errcode;
    if (errcode === 0 || errcode == null) return undefined;
    const errmsg = String(body?.errmsg ?? (res as { errmsg?: unknown }).errmsg ?? "error");
    return `WeCom errcode ${String(errcode)}: ${errmsg}`;
  }
}

function coerceList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizePolicy(value: unknown): WeComAccessPolicy {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "open" || raw === "allowlist" || raw === "disabled" || raw === "pairing") {
    return raw;
  }
  return "pairing";
}

function coerceNonNegativeMs(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function detectWeComMediaType(contentType: string): WeComMediaType {
  const normalized = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/") || normalized === "application/ogg") return "voice";
  return "file";
}

function applyMediaSizeLimits(
  fileSize: number,
  detectedType: WeComMediaType,
  contentType: string,
): Pick<PreparedOutboundMedia, "finalType" | "rejected" | "rejectReason" | "downgraded" | "downgradeNote"> {
  const sizeMb = fileSize / (1024 * 1024);
  const normalizedContentType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();

  if (fileSize > FILE_MAX_BYTES) {
    return {
      finalType: detectedType,
      rejected: true,
      rejectReason: `文件大小 ${sizeMb.toFixed(2)}MB 超过企业微信 20MB 限制，无法发送。`,
      downgraded: false,
    };
  }

  if (detectedType === "image" && fileSize > IMAGE_MAX_BYTES) {
    return {
      finalType: "file",
      rejected: false,
      downgraded: true,
      downgradeNote: `图片大小 ${sizeMb.toFixed(2)}MB 超过 10MB 限制，已转为文件格式发送。`,
    };
  }

  if (detectedType === "video" && fileSize > VIDEO_MAX_BYTES) {
    return {
      finalType: "file",
      rejected: false,
      downgraded: true,
      downgradeNote: `视频大小 ${sizeMb.toFixed(2)}MB 超过 10MB 限制，已转为文件格式发送。`,
    };
  }

  if (detectedType === "voice") {
    if (normalizedContentType && !VOICE_SUPPORTED_MIMES.has(normalizedContentType)) {
      return {
        finalType: "file",
        rejected: false,
        downgraded: true,
        downgradeNote: `语音格式 ${normalizedContentType} 不支持，企业微信原生语音仅支持 AMR，已转为文件格式发送。`,
      };
    }
    if (fileSize > VOICE_MAX_BYTES) {
      return {
        finalType: "file",
        rejected: false,
        downgraded: true,
        downgradeNote: `语音大小 ${sizeMb.toFixed(2)}MB 超过 2MB 限制，已转为文件格式发送。`,
      };
    }
  }

  return { finalType: detectedType, rejected: false, downgraded: false };
}

function normalizeContentType(contentType: string, filename: string): string {
  const normalized = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream" && normalized !== "text/plain") return normalized;
  return mimeForExtension(extname(filename).toLowerCase()) || normalized || "application/octet-stream";
}

function mimeForExtension(ext: string): string | undefined {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".amr":
      return "audio/amr";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    default:
      return undefined;
  }
}

function extForMime(mimeType: string): string | undefined {
  const normalized = String(mimeType || "").split(";", 1)[0].trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "audio/amr":
      return ".amr";
    case "application/pdf":
      return ".pdf";
    default:
      return undefined;
  }
}

function defaultExtForMedia(kind: WeComMediaType): string {
  switch (kind) {
    case "image":
      return ".jpg";
    case "video":
      return ".mp4";
    case "voice":
      return ".amr";
    case "file":
      return ".bin";
  }
}

async function extractWeComDeliverables(text: string): Promise<WeComDeliverableExtraction> {
  const protectedText = maskProtectedDeliverableSpans(text);
  const candidates: WeComDeliverableCandidate[] = [];
  const protectedMediaSpans: Array<[number, number]> = [];

  for (const match of protectedText.matchAll(MEDIA_TAG_RE)) {
    const rawPath = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!rawPath) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    candidates.push({ rawPath, start, end });
    protectedMediaSpans.push([start, end]);
  }

  const bareSearchText = maskRanges(protectedText, protectedMediaSpans);
  for (const match of bareSearchText.matchAll(BARE_DELIVERABLE_RE)) {
    const rawPath = match[2];
    if (!rawPath) continue;
    const start = (match.index ?? 0) + match[1].length;
    candidates.push({ rawPath, start, end: start + rawPath.length });
  }

  const deliverables: WeComDeliverable[] = [];
  const warnings = new Set<string>();
  const seenPaths = new Set<string>();

  for (const candidate of candidates.sort((a, b) => a.start - b.start)) {
    const validated = await validateWeComDeliverablePath(candidate.rawPath);
    if (!validated.ok) {
      warnings.add(`附件未发送：${validated.reason}`);
      continue;
    }
    if (seenPaths.has(validated.deliverable.path)) {
      continue;
    }
    seenPaths.add(validated.deliverable.path);
    deliverables.push(validated.deliverable);
  }

  return {
    text: text.trim(),
    deliverables,
    warnings: Array.from(warnings),
  };
}

async function validateWeComDeliverablePath(rawPath: string): Promise<
  | { ok: true; deliverable: WeComDeliverable }
  | { ok: false; reason: string }
> {
  const normalized = normalizeDeliverablePath(rawPath);
  if (!normalized) return { ok: false, reason: "附件路径为空。" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) && !normalized.startsWith("file:")) {
    return { ok: false, reason: "企业微信附件投递仅支持本地文件路径。" };
  }

  const localPath = normalized.startsWith("file:")
    ? fileURLToPath(normalized)
    : normalized.startsWith("~/")
      ? join(homedir(), normalized.slice(2))
      : normalized;
  if (!localPath.startsWith("/")) {
    return { ok: false, reason: "附件路径必须是绝对路径或 ~/ 路径。" };
  }

  const resolvedPath = resolve(localPath);
  const ext = extname(resolvedPath).toLowerCase();
  if (!DELIVERABLE_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `不支持的附件类型 ${ext || "(无扩展名)"}。` };
  }
  if (isDeniedDeliverablePath(resolvedPath)) {
    return { ok: false, reason: "该路径位于敏感目录或敏感配置文件中。" };
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(resolvedPath);
  } catch {
    return { ok: false, reason: "附件文件不存在。" };
  }
  if (!info.isFile()) {
    return { ok: false, reason: "附件路径不是普通文件。" };
  }

  const realPath = await realpath(resolvedPath).catch(() => resolvedPath);
  if (isDeniedDeliverablePath(realPath)) {
    return { ok: false, reason: "该路径位于敏感目录或敏感配置文件中。" };
  }

  return {
    ok: true,
    deliverable: {
      path: realPath,
      mediaType: mediaTypeForDeliverableExt(ext),
    },
  };
}

function normalizeDeliverablePath(rawPath: string): string {
  return rawPath.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[.,;:)\]}]+$/g, "");
}

function mediaTypeForDeliverableExt(ext: string): WeComMediaType {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".ogg", ".opus", ".m4a", ".flac", ".amr"].includes(ext)) return "voice";
  return "file";
}

function isDeniedDeliverablePath(path: string): boolean {
  const normalized = resolve(path);
  const home = homedir();
  const pilotHome = process.env.PILOT_HOME || join(home, ".pilotdeck");
  if (pathUnder(normalized, join(home, ".ssh"))) return true;
  if (pathUnder(normalized, join(pilotHome, "server-token"))) return true;
  if (pathUnder(normalized, join(pilotHome, "pilotdeck.yaml"))) return true;

  const lowerBase = basename(normalized).toLowerCase();
  if (DENIED_BASENAMES.has(lowerBase)) return true;

  const segments = normalized.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  return segments.some((segment) => DENIED_SEGMENTS.has(segment));
}

function pathUnder(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function maskProtectedDeliverableSpans(text: string): string {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(/```[\s\S]*?```/g)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  for (const match of text.matchAll(/`[^`\n]+`/g)) {
    const start = match.index ?? 0;
    const prefix = text.slice(Math.max(0, start - 20), start);
    if (/MEDIA:\s*$/i.test(prefix)) continue;
    ranges.push([start, start + match[0].length]);
  }
  for (const match of text.matchAll(/^>.*$/gm)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  return maskRanges(text, ranges);
}

function maskRanges(text: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return text;
  const chars = text.split("");
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i += 1) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}



function safeFileName(value: string): string {
  const name = basename(value || "wecom_media").replace(/[^\w.\-()\u4e00-\u9fff]+/g, "_");
  return name || "wecom_media";
}

function tryParseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function guessFileName(url: string, contentDisposition?: string): string {
  const disposition = contentDisposition ?? "";
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
  const quotedMatch = /filename="?([^";]+)"?/i.exec(disposition);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const parsed = tryParseUrl(url);
  const pathName = parsed?.pathname ? basename(parsed.pathname) : "";
  return pathName || "wecom_media";
}

function decryptWeComBytes(encryptedData: Buffer, aesKey: string): Buffer {
  const paddedKey = aesKey + "=".repeat((4 - (aesKey.length % 4)) % 4);
  const key = Buffer.from(paddedKey, "base64");
  if (key.length !== 32) {
    throw new Error(`Invalid WeCom AES key length: expected 32 bytes, got ${key.length}`);
  }
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  const padLen = decrypted.at(-1) ?? 0;
  if (padLen < 1 || padLen > 32 || padLen > decrypted.length) {
    throw new Error(`Invalid PKCS#7 padding value: ${padLen}`);
  }
  for (const byte of decrypted.subarray(decrypted.length - padLen)) {
    if (byte !== padLen) throw new Error("Invalid PKCS#7 padding bytes");
  }
  return decrypted.subarray(0, decrypted.length - padLen);
}

function normalizeEntry(value: string): string {
  return value.trim().toLowerCase().replace(/^wecom:(user|group):/, "");
}

function entryMatches(entries: string[], value: string): boolean {
  const normalized = normalizeEntry(value);
  return entries.some((entry) => {
    const candidate = normalizeEntry(entry);
    return candidate === "*" || candidate === normalized;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function trimMap<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const first = map.keys().next().value;
    if (first == null) break;
    map.delete(first);
  }
}
