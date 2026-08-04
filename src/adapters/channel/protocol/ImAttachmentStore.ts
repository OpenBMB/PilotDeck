import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  headers?: HeadersInit;
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
      response = await this.fetchImpl(input.url, { headers: input.headers, signal: controller.signal });
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

    const responseMimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || undefined;
    const mimeType = normalizeAttachmentMimeType(input.mimeType ?? responseMimeType, buffer, input.type);
    const dir = this.safeDir(input.chatId, input.messageId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const filename = this.safeFilename(input.name, mimeType, input.type);
    const path = resolve(dir, filename);
    if (!isPathWithinDirectory(path, dir)) {
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
    if (type === "image") {
      return replaceExtension(cleaned, extensionForMime(mimeType));
    }
    if (extname(cleaned)) return cleaned;
    return `${cleaned}.${extensionForMime(mimeType)}`;
  }
}

function normalizeAttachmentMimeType(
  mimeType: string | undefined,
  buffer: Buffer,
  type: ChannelAttachment["type"],
): string | undefined {
  if (type !== "image") return mimeType;
  return detectImageMime(buffer) ?? mimeType;
}

function detectImageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function replaceExtension(name: string, extension: string): string {
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base || "image"}.${extension}`;
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "unknown";
}

export function isPathWithinDirectory(
  candidate: string,
  directory: string,
  pathApi: Pick<typeof import("node:path"), "relative" | "isAbsolute"> = { relative, isAbsolute },
): boolean {
  const rel = pathApi.relative(directory, candidate);
  return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
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
