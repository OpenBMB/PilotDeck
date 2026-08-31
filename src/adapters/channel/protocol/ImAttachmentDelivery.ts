import { readFile } from "node:fs/promises";
import type { GatewayOutboundAttachment } from "../../../gateway/index.js";

export type PreparedImAttachment = {
  name: string;
  mimeType?: string;
  buffer: Buffer;
  fileType: "image" | "file";
  path?: string;
};

export type ImAttachmentDeliveryOptions = {
  maxBytes: number;
  sendPrepared(attachment: PreparedImAttachment): Promise<void>;
  sendTextFallback(text: string): Promise<void>;
  logger?: { info?(message: string): void; warn?(message: string): void; error?(message: string): void };
};

export class ImAttachmentDelivery {
  constructor(private readonly options: ImAttachmentDeliveryOptions) {}

  async send(attachment: GatewayOutboundAttachment): Promise<boolean> {
    if (attachment.source === "local_path" && attachment.path) {
      await this.options.sendTextFallback(`附件 ${attachment.path} 需要授权后才能发送。`);
      return false;
    }

    try {
      const prepared = await this.prepare(attachment);
      await this.options.sendPrepared(prepared);
      return true;
    } catch (error) {
      this.options.logger?.error?.(`IM attachment send failed: ${formatError(error)}`);
      await this.options.sendTextFallback(formatImAttachmentFallback(attachment));
      return false;
    }
  }

  private async prepare(attachment: GatewayOutboundAttachment): Promise<PreparedImAttachment> {
    const name = sanitizeFilename(attachment.name ?? attachment.path?.split(/[\\/]/).pop() ?? "attachment");
    const buffer = attachment.content
      ? Buffer.from(attachment.content, "base64")
      : attachment.path
        ? await readPersistedAttachment(attachment.path, attachment.source)
        : undefined;
    if (!buffer) throw new Error("attachment has neither content nor path");
    if (buffer.byteLength > this.options.maxBytes) {
      throw new Error(`attachment ${name} is ${buffer.byteLength} bytes (limit ${this.options.maxBytes})`);
    }
    const mimeType = attachment.mimeType ?? guessMimeTypeFromName(name);
    const fileType = attachment.type === "image" || mimeType?.startsWith("image/") ? "image" : "file";
    return { name, mimeType, buffer, fileType, ...(attachment.path ? { path: attachment.path } : {}) };
  }
}

async function readPersistedAttachment(path: string, source?: GatewayOutboundAttachment["source"]): Promise<Buffer> {
  const persisted = await readFile(path);
  return source === "media_reference" && path.endsWith(".b64")
    ? Buffer.from(persisted.toString("utf8"), "base64")
    : persisted;
}

export function guessMimeTypeFromName(name: string | undefined): string | undefined {
  const lower = name?.toLowerCase() ?? "";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  return undefined;
}

export function formatImAttachmentFallback(attachment: GatewayOutboundAttachment): string {
  const name = attachment.name ?? attachment.path?.split(/[\\/]/).pop() ?? "附件";
  const pathText = attachment.path ? `，可在本机查看：${attachment.path}` : "";
  return `附件发送失败：${name}${pathText}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\\/:*?"<>|]+/g, "_").trim().slice(0, 180) || "attachment.bin";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
