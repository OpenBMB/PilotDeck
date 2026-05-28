import { join } from "node:path";
import type { Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelLogger, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { MatrixSessionMapper } from "./MatrixSessionMapper.js";
import { renderMatrixEvent } from "./matrix-render.js";

let MatrixSdk: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  MatrixSdk = require("matrix-bot-sdk");
} catch {
  // matrix-bot-sdk not installed — start() will warn
}

const MAX_MESSAGE_LENGTH = 4000;

export type MatrixChannelOptions = {
  accessToken?: string;
  homeserver?: string;
  userId?: string;
  storagePath?: string;
  mapper?: MatrixSessionMapper;
};

export class MatrixChannel implements ChannelAdapter {
  readonly channelKey: GatewayChannelKey = "matrix";

  private readonly mapper: MatrixSessionMapper;
  private readonly accessToken?: string;
  private readonly homeserver?: string;
  private readonly userIdOption?: string;
  private readonly storagePath: string;

  private gateway?: Gateway;
  private logger?: ChannelLogger;
  private client: any = null;
  private userId: string | null = null;
  private activeChats = new Set<string>();

  constructor(options: MatrixChannelOptions = {}) {
    this.mapper = options.mapper ?? new MatrixSessionMapper();
    this.accessToken = options.accessToken ?? process.env.MATRIX_ACCESS_TOKEN;
    this.homeserver = (options.homeserver ?? process.env.MATRIX_HOMESERVER ?? "").replace(/\/$/, "") || undefined;
    this.userIdOption = options.userId ?? process.env.MATRIX_USER_ID;
    this.storagePath = options.storagePath ?? join(process.cwd(), ".matrix-bot-storage.json");
  }

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    this.gateway = deps.gateway;
    this.logger = deps.logger;

    if (!MatrixSdk) {
      this.logger?.error?.("matrix: matrix-bot-sdk not installed; run `npm install matrix-bot-sdk`");
      return { stop: async () => undefined };
    }
    if (!this.homeserver) {
      this.logger?.error?.("matrix: homeserver not set (MATRIX_HOMESERVER)");
      return { stop: async () => undefined };
    }
    if (!this.accessToken) {
      this.logger?.error?.("matrix: access token not set (MATRIX_ACCESS_TOKEN)");
      return { stop: async () => undefined };
    }

    const { MatrixClient, SimpleFsStorageProvider } = MatrixSdk;

    try {
      const storage = new SimpleFsStorageProvider(this.storagePath);
      this.client = new MatrixClient(this.homeserver, this.accessToken, storage);

      try {
        this.userId = (await this.client.getUserId()) ?? this.userIdOption ?? null;
      } catch {
        this.userId = this.userIdOption ?? null;
      }

      this.client.on("room.invite", async (roomId: string) => {
        try {
          await this.client.joinRoom(roomId);
        } catch (e) {
          this.logger?.warn?.(`matrix: joinRoom failed: ${e}`);
        }
      });

      this.client.on("room.message", (roomId: string, raw: any) => {
        void this.handleRoomMessage(roomId, raw).catch((e) => {
          this.logger?.error?.(`matrix: room.message error: ${e}`);
        });
      });

      await this.client.start();
      this.logger?.info?.(`matrix: syncing as ${this.userId ?? "(unknown user)"}`);
    } catch (e) {
      this.logger?.error?.(`matrix: start failed: ${e}`);
      return { stop: async () => undefined };
    }

    return {
      stop: async (reason?: string) => {
        this.logger?.info?.(`matrix: stopping (${reason ?? "no reason"})`);
        if (this.client) {
          try { this.client.stop(); } catch { /* best effort */ }
          this.client = null;
        }
        this.userId = null;
      },
    };
  }

  private async handleRoomMessage(roomId: string, raw: any): Promise<void> {
    const sender = raw?.sender as string | undefined;
    if (!sender) return;
    if (this.userId && sender === this.userId) return;

    const content = raw.content ?? {};
    const relates = content["m.relates_to"] ?? {};
    if (relates["rel_type"] === "m.replace") return;

    const msgtype = (content.msgtype as string) || "m.text";
    if (msgtype !== "m.text") return;
    if (content.msgtype === "m.notice") return;

    const text = String(content.body ?? "").trim();
    if (!text) return;

    if (this.activeChats.has(roomId)) {
      this.logger?.info?.(`matrix: room ${roomId} already active, skipping`);
      return;
    }

    const mapped = this.mapper.resolve({ chatId: roomId, text });
    if (mapped.command === "new" && !mapped.message) {
      await this.sendReply(roomId, "已创建新会话。");
      return;
    }
    if (!mapped.message) return;

    this.activeChats.add(roomId);
    try {
      await this.processMessage(roomId, mapped.sessionKey, mapped.message);
    } finally {
      this.activeChats.delete(roomId);
    }
  }

  private async processMessage(roomId: string, sessionKey: string, message: string): Promise<void> {
    if (!this.gateway) return;

    let replyText = "";
    try {
      for await (const event of this.gateway.submitTurn({
        sessionKey,
        channelKey: "matrix",
        message,
      })) {
        const fragment = renderMatrixEvent(event);
        if (fragment != null) replyText += fragment;
      }
    } catch (e) {
      this.logger?.error?.(`matrix: submitTurn error: ${e}`);
      replyText = "处理消息时发生错误，请重试。";
    }

    const finalText = replyText.trim();
    if (finalText) {
      await this.sendReply(roomId, finalText);
    }
  }

  private async sendReply(roomId: string, text: string): Promise<void> {
    if (!this.client) return;
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      try {
        await this.client.sendMessage(roomId, {
          msgtype: "m.text",
          body: chunk,
        });
      } catch (e) {
        this.logger?.error?.(`matrix: sendMessage failed: ${e}`);
      }
    }
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
