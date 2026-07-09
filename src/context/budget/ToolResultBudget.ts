import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalMediaReferenceBlock,
  CanonicalPdfBlock,
  CanonicalToolResultBlock,
  CanonicalToolResultContentBlock,
  CanonicalToolResultReferenceBlock,
} from "../../model/index.js";
import { flattenToolResultBlockText } from "../../model/index.js";

/** Default aggregate cap (chars) — mirrors legacy `DEFAULT_MAX_RESULT_SIZE_CHARS`. */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
/** Inline preview length included alongside the persisted reference. */
export const PREVIEW_SIZE_BYTES = 2_000;

export type ToolResultBudgetState = {
  replacements: Map<string, ToolResultReplacementRecord>;
};

export type ToolResultReplacementRecord = {
  toolCallId: string;
  isError?: boolean;
  path: string;
  originalBytes: number;
  preview: string;
  mimeType?: string;
  reason: string;
};

export type MediaReplacementRecord = {
  id: string;
  toolCallId: string;
  path: string;
  originalBytes: number;
  preview: string;
  mimeType: string;
  mediaType: "image" | "pdf" | "audio";
  pages?: number;
  detail?: "auto" | "low" | "high";
  reason: string;
};

export type ToolResultBudgetOptions = {
  maxResultSizeChars?: number;
  previewBytes?: number;
  toolResultsDir: string;
  state?: ToolResultBudgetState;
};

export type ToolResultBudgetApplyOptions = {
  turnId?: string;
};

export function createToolResultBudgetState(): ToolResultBudgetState {
  return { replacements: new Map() };
}

/**
 * Replace tool_result blocks whose serialized text exceeds the budget with
 * structured `tool_result_reference` blocks. Persists the original body to
 * `{toolResultsDir}/{turnId}-{toolCallId}.{json|txt}` when a turn id is
 * available (write flag 'wx' to avoid overwriting on resume).
 */
export class ToolResultBudget {
  private readonly maxResultSizeChars: number;
  private readonly previewBytes: number;
  private readonly toolResultsDir: string;
  private readonly state: ToolResultBudgetState;

  constructor(options: ToolResultBudgetOptions) {
    this.maxResultSizeChars = options.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
    this.previewBytes = options.previewBytes ?? PREVIEW_SIZE_BYTES;
    this.toolResultsDir = resolve(options.toolResultsDir);
    this.state = options.state ?? createToolResultBudgetState();
  }

  getState(): ToolResultBudgetState {
    return this.state;
  }

  async applyToMessage(
    message: CanonicalMessage,
    options: ToolResultBudgetApplyOptions = {},
  ): Promise<CanonicalMessage> {
    if (message.role !== "user") {
      return message;
    }
    const primaryContent: CanonicalMessage["content"] = [];
    const mediaReferences: CanonicalMediaReferenceBlock[] = [];
    let modified = false;
    for (const block of message.content) {
      if (block.type !== "tool_result") {
        primaryContent.push(block);
        continue;
      }
      const replaced = await this.maybeReplaceToolResult(block, options);
      if (replaced.block !== block || replaced.mediaReferences.length > 0) {
        modified = true;
      }
      primaryContent.push(replaced.block);
      mediaReferences.push(...replaced.mediaReferences);
    }
    if (!modified) {
      return message;
    }
    return { ...message, content: [...primaryContent, ...mediaReferences] };
  }

  async applyToSupplementalMessage(
    message: CanonicalMessage,
    toolCallId: string,
    options: ToolResultBudgetApplyOptions = {},
  ): Promise<CanonicalMessage> {
    if (message.role !== "user") {
      return message;
    }
    const newContent: CanonicalContentBlock[] = [];
    let modified = false;
    for (let index = 0; index < message.content.length; index += 1) {
      const block = message.content[index];
      const replaced = await this.maybeReplaceMedia(block, index, toolCallId, options);
      if (replaced !== block) {
        modified = true;
      }
      newContent.push(replaced);
    }
    return modified ? { ...message, content: newContent } : message;
  }

  private async maybeReplaceToolResult(
    block: CanonicalToolResultBlock,
    options: ToolResultBudgetApplyOptions,
  ): Promise<{
    block: CanonicalToolResultBlock | CanonicalToolResultReferenceBlock;
    mediaReferences: CanonicalMediaReferenceBlock[];
  }> {
    if (!block.content.some(isToolResultMediaBlock)) {
      return { block: await this.maybeReplaceTextToolResult(block, options), mediaReferences: [] };
    }

    const content: CanonicalToolResultContentBlock[] = [];
    const mediaReferences: CanonicalMediaReferenceBlock[] = [];

    for (let index = 0; index < block.content.length; index += 1) {
      const entry = block.content[index];
      if (!isToolResultMediaBlock(entry)) {
        content.push(entry);
        continue;
      }

      const replaced = await this.maybeReplaceMedia(entry, index, block.toolCallId, options);
      if (replaced.type === "media_reference") {
        mediaReferences.push(replaced);
        content.push({ type: "text", text: replaced.preview });
      } else {
        content.push(entry);
      }
    }

    return {
      block: mediaReferences.length > 0 ? { ...block, content } : block,
      mediaReferences,
    };
  }

  private async maybeReplaceTextToolResult(
    block: CanonicalToolResultBlock,
    options: ToolResultBudgetApplyOptions,
  ): Promise<CanonicalToolResultBlock | CanonicalToolResultReferenceBlock> {
    const replacementKey = scopedToolResultKey(block.toolCallId, options.turnId);
    if (this.state.replacements.has(replacementKey)) {
      return this.toReferenceBlock(this.state.replacements.get(replacementKey)!);
    }

    const flat = flattenToolResultBlockText(block);
    const byteLength = Buffer.byteLength(flat, "utf8");
    if (byteLength <= this.maxResultSizeChars) {
      return block;
    }

    const isJson = looksLikeJson(flat);
    const ext = isJson ? "json" : "txt";
    const path = resolve(this.toolResultsDir, `${replacementKey}.${ext}`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await access(path);
      // already exists — do not overwrite (legacy 'wx' flag); reuse existing record.
    } catch {
      await writeFile(path, flat, { flag: "wx", mode: 0o600, encoding: "utf8" });
    }

    const preview = headTailPreview(flat, this.previewBytes);
    const record: ToolResultReplacementRecord = {
      toolCallId: block.toolCallId,
      isError: block.isError,
      path,
      originalBytes: byteLength,
      preview,
      mimeType: isJson ? "application/json" : "text/plain",
      reason: "tool_result_too_large",
    };
    this.state.replacements.set(replacementKey, record);
    return this.toReferenceBlock(record);
  }

  private toReferenceBlock(record: ToolResultReplacementRecord): CanonicalToolResultReferenceBlock {
    return {
      type: "tool_result_reference",
      toolCallId: record.toolCallId,
      isError: record.isError,
      path: record.path,
      originalBytes: record.originalBytes,
      preview: record.preview,
      hasMore: Buffer.byteLength(record.preview, "utf8") < record.originalBytes,
      mimeType: record.mimeType,
      reason: record.reason,
    };
  }

  private async maybeReplaceMedia(
    block: CanonicalContentBlock,
    index: number,
    toolCallId: string,
    options: ToolResultBudgetApplyOptions,
  ): Promise<CanonicalContentBlock> {
    if (block.type !== "image" && block.type !== "pdf" && block.type !== "audio") {
      return block;
    }
    const originalBytes = mediaOriginalBytes(block);
    const encodedBytes = Buffer.byteLength(block.data, "utf8");
    if (encodedBytes <= this.maxResultSizeChars) {
      return block;
    }

    const mediaType = block.type;
    const mimeType = block.mimeType;
    const ext = extensionForMedia(mediaType, mimeType);
    const id = `${scopedToolResultKey(toolCallId, options.turnId)}-${mediaType}-${index}-${hashString(block.data).slice(0, 12)}`;
    const path = resolve(this.toolResultsDir, `${id}.${ext}`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await access(path);
    } catch {
      await writeFile(path, block.data, { flag: "wx", mode: 0o600, encoding: "utf8" });
    }

    const record: MediaReplacementRecord = {
      id,
      toolCallId,
      path,
      originalBytes,
      preview: mediaPreview(mediaType, mimeType, originalBytes, block),
      mimeType,
      mediaType,
      reason: "media_result_too_large",
      ...(block.type === "pdf" && block.pages !== undefined ? { pages: block.pages } : {}),
      ...(block.type === "image" && block.detail ? { detail: block.detail } : {}),
    };
    return this.toMediaReferenceBlock(record);
  }

  private toMediaReferenceBlock(record: MediaReplacementRecord): CanonicalMediaReferenceBlock {
    return {
      type: "media_reference",
      toolCallId: record.toolCallId,
      path: record.path,
      originalBytes: record.originalBytes,
      preview: record.preview,
      hasMore: true,
      mimeType: record.mimeType,
      mediaType: record.mediaType,
      ...(record.pages !== undefined ? { pages: record.pages } : {}),
      ...(record.detail ? { detail: record.detail } : {}),
      reason: record.reason,
    };
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(buffer.length, maxBytes);
  while (end > 0 && (buffer[end] & 0b11000000) === 0b10000000) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Head + tail preview: first half of budget from the start,
 * last half from the end, joined by a separator.
 */
function headTailPreview(value: string, budgetBytes: number): string {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= budgetBytes) {
    return value;
  }
  const halfBudget = Math.floor(budgetBytes / 2) - 20;
  if (halfBudget <= 0) {
    return truncateToBytes(value, budgetBytes);
  }
  const head = truncateToBytes(value, halfBudget);
  const tailStart = value.length - halfBudget * 2;
  const tail = tailStart > 0 ? value.slice(tailStart) : "";
  const omitted = totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return `${head}\n\n... [${omitted} bytes omitted] ...\n\n${tail}`;
}

/** Helper for tests / inspection. */
export function flattenToolResultText(block: CanonicalToolResultBlock): string {
  return flattenToolResultBlockText(block);
}

function isToolResultMediaBlock(
  block: CanonicalToolResultContentBlock,
): block is Extract<CanonicalToolResultContentBlock, { type: "image" | "pdf" }> {
  return block.type === "image" || block.type === "pdf";
}

function mediaOriginalBytes(block: Extract<CanonicalContentBlock, { type: "image" | "pdf" | "audio" }>): number {
  return ("bytes" in block ? block.bytes : undefined) ?? Buffer.byteLength(block.data, "utf8");
}

function scopedToolResultKey(toolCallId: string, turnId: string | undefined): string {
  const safeToolCallId = safePathPart(toolCallId) || "tool-call";
  const safeTurnId = turnId === undefined ? undefined : safePathPart(turnId);
  return safeTurnId ? `${safeTurnId}-${safeToolCallId}` : safeToolCallId;
}

function safePathPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function extensionForMedia(mediaType: "image" | "pdf" | "audio", mimeType: string): string {
  if (mediaType === "pdf") return "pdf.b64";
  const subType = mimeType.split("/")[1]?.toLowerCase().replace(/[^a-z0-9.+-]/g, "");
  return `${subType || mediaType}.b64`;
}

function mediaPreview(
  mediaType: "image" | "pdf" | "audio",
  mimeType: string,
  originalBytes: number,
  block: Extract<CanonicalContentBlock, { type: "image" | "pdf" | "audio" }>,
): string {
  const size = `${originalBytes} bytes`;
  if (mediaType === "pdf") {
    const pages = (block as CanonicalPdfBlock).pages;
    return `[PDF omitted from memory: ${mimeType}, ${size}${pages ? `, ${pages} pages` : ""}]`;
  }
  return `[${mediaType} omitted from memory: ${mimeType}, ${size}]`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
