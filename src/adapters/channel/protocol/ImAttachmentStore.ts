import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { ChannelAttachment } from "../../../gateway/index.js";

export type ImAttachmentStoreOptions = {
  rootDir: string;
  channelKey: string;
  maxBytes?: number;
  fetchTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type SaveAttachmentFromUrlInput = {
  url: string;
  chatId: string;
  messageId: string;
  type: ChannelAttachment["type"];
  name?: string;
  mimeType?: string;
  bytes?: number;
  metadata?: Record<string, unknown>;
  transform?: (buffer: Buffer) => Uint8Array | Promise<Uint8Array>;
};

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

export class ImAttachmentStore {
  private readonly rootDir: string;
  private readonly channelKey: string;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fetchTimeoutMs: number;

  constructor(options: ImAttachmentStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.channelKey = options.channelKey;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async saveFromUrl(input: SaveAttachmentFromUrlInput): Promise<ChannelAttachment> {
    if (typeof input.bytes === "number" && input.bytes > this.maxBytes) {
      throw new Error(`Attachment ${input.name ?? input.url} is ${input.bytes} bytes (limit ${this.maxBytes}).`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(input.url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`Attachment download failed HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
      throw new Error(`Attachment is ${contentLength} bytes (limit ${this.maxBytes}).`);
    }

    let buffer = Buffer.from(await response.arrayBuffer());
    if (input.transform) {
      buffer = Buffer.from(await input.transform(buffer));
    }
    if (buffer.byteLength > this.maxBytes) {
      throw new Error(`Attachment is ${buffer.byteLength} bytes (limit ${this.maxBytes}).`);
    }

    const mimeType = input.mimeType ?? (response.headers.get("content-type")?.split(";", 1)[0]?.trim() || undefined);
    const dir = this.safeDir(input.chatId, input.messageId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const filename = this.safeFilename(input.name, mimeType, input.type);
    const path = resolve(dir, filename);
    if (!path.startsWith(`${dir}/`) && path !== dir) {
      throw new Error("Attachment path escaped target directory.");
    }
    await writeFile(path, buffer, { mode: 0o600 });
    const info = await stat(path);

    return {
      type: input.type,
      name: filename,
      path,
      mimeType,
      bytes: info.size,
      metadata: {
        channelKey: this.channelKey,
        chatId: input.chatId,
        messageId: input.messageId,
        sourceUrl: input.url,
        ...input.metadata,
      },
    };
  }

  private safeDir(chatId: string, messageId: string): string {
    return resolve(
      this.rootDir,
      safePathPart(this.channelKey),
      safePathPart(chatId),
      safePathPart(messageId),
    );
  }

  private safeFilename(name: string | undefined, mimeType: string | undefined, type: ChannelAttachment["type"]): string {
    const fallback = type === "image" ? `image.${extensionForMime(mimeType)}` : `attachment.${extensionForMime(mimeType)}`;
    const raw = basename(name?.trim() || fallback);
    const cleaned = raw.replace(/[\x00-\x1f\\/:*?"<>|]+/g, "_").slice(0, 180) || fallback;
    if (extname(cleaned)) return cleaned;
    return `${cleaned}.${extensionForMime(mimeType)}`;
  }
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "unknown";
}

function extensionForMime(mimeType: string | undefined): string {
  switch (mimeType?.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    case "text/plain":
      return "txt";
    default:
      return "bin";
  }
}
