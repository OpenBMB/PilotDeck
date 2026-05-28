import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  CanonicalMessage,
  CanonicalToolResultBlock,
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
  path: string;
  originalBytes: number;
  preview: string;
  mimeType?: string;
  reason: string;
};

export type ToolResultBudgetOptions = {
  maxResultSizeChars?: number;
  previewBytes?: number;
  toolResultsDir: string;
  state?: ToolResultBudgetState;
};

export function createToolResultBudgetState(): ToolResultBudgetState {
  return { replacements: new Map() };
}

/**
 * Replace tool_result blocks whose serialized text exceeds the budget with
 * structured `tool_result_reference` blocks. Persists the original body to
 * `{toolResultsDir}/{toolCallId}.{json|txt}` (write flag 'wx' to avoid
 * overwriting on resume).
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

  async applyToMessage(message: CanonicalMessage): Promise<CanonicalMessage> {
    if (message.role !== "user") {
      return message;
    }
    const newContent: CanonicalMessage["content"] = [];
    let modified = false;
    for (const block of message.content) {
      if (block.type !== "tool_result") {
        newContent.push(block);
        continue;
      }
      const replaced = await this.maybeReplace(block);
      if (replaced !== block) {
        modified = true;
      }
      newContent.push(replaced);
    }
    if (!modified) {
      return message;
    }
    return { ...message, content: newContent };
  }

  private async maybeReplace(
    block: CanonicalToolResultBlock,
  ): Promise<CanonicalToolResultBlock | CanonicalToolResultReferenceBlock> {
    if (block.content.some((entry) => entry.type !== "text")) {
      return block;
    }
    if (this.state.replacements.has(block.toolCallId)) {
      return this.toReferenceBlock(this.state.replacements.get(block.toolCallId)!);
    }

    const flat = flattenToolResultBlockText(block);
    const byteLength = Buffer.byteLength(flat, "utf8");
    if (byteLength <= this.maxResultSizeChars) {
      return block;
    }

    const isJson = looksLikeJson(flat);
    const ext = isJson ? "json" : "txt";
    const path = resolve(this.toolResultsDir, `${block.toolCallId}.${ext}`);
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
      path,
      originalBytes: byteLength,
      preview,
      mimeType: isJson ? "application/json" : "text/plain",
      reason: "tool_result_too_large",
    };
    this.state.replacements.set(block.toolCallId, record);
    return this.toReferenceBlock(record);
  }

  private toReferenceBlock(record: ToolResultReplacementRecord): CanonicalToolResultReferenceBlock {
    return {
      type: "tool_result_reference",
      toolCallId: record.toolCallId,
      path: record.path,
      originalBytes: record.originalBytes,
      preview: record.preview,
      hasMore: record.preview.length < record.originalBytes,
      mimeType: record.mimeType,
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
