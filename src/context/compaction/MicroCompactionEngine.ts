import type {
  CanonicalMessage,
  CanonicalToolResultBlock,
} from "../../model/index.js";
import { flattenToolResultBlockText } from "../../model/index.js";
import { countTokens } from "../budget/tokenizer.js";
import { COMPACTABLE_TOOL_NAMES } from "./CachedMicroCompactionEngine.js";
import {
  collectToolNamesByCallId,
  isProtectedToolCallId,
  protectedToolNameSet,
} from "./protectedContext.js";

export const MICROCOMPACT_CLEARED = "[Old tool result content compacted]";
export const MICROCOMPACT_FAILURES_FOLDED = "[Repeated tool failures compacted]";
export const MICROCOMPACT_RECOVERED_FAILURE_PREFIX = "[Recovered tool error compacted";

export type MicroCompactionInput = {
  messages: CanonicalMessage[];
  /** Now() epoch in ms used to determine `idle for X` time-based decisions. */
  nowMs?: number;
  /** Microcompact only kicks in after this many ms of idle (legacy default ~5min). */
  idleMs?: number;
  /** Max bytes per tool_result allowed to remain after rewrite (legacy default ~512). */
  trimToBytes?: number;
  /** Max tokens per bounded tool result. Takes precedence over trimToBytes. */
  trimToTokens?: number;
  /** Optional per-pass override for the number of newest results kept verbatim. */
  keepLatest?: number;
  /** Override protected tools for emergency projection; null disables protection. */
  protectedToolNames?: Iterable<string> | null;
};

export type MicroCompactionEngineOptions = {
  keepLatest?: number;
  trimToBytes?: number;
  trimToTokens?: number;
  protectedToolNames?: Iterable<string>;
};

export type MicroCompactionResult = {
  messages: CanonicalMessage[];
  rewritten: number;
  rewrittenBytes: number;
  toolCallIds: string[];
  appliedTrigger: "time_based" | "skipped";
};

/**
 * Phase 5 microcompact (time-based path only — decision §3.1 #5):
 * directly rewrites tool_result content in older messages so subsequent turns
 * carry less context. Only targets tool_results whose originating tool_call
 * is in COMPACTABLE_TOOL_NAMES. Properly accounts for multimodal content
 * size (base64 data length) rather than relying on the text-only fallback.
 */
export class MicroCompactionEngine {
  private readonly protectedToolNames: ReadonlySet<string>;

  constructor(private readonly options: MicroCompactionEngineOptions = {}) {
    this.protectedToolNames = protectedToolNameSet(options.protectedToolNames);
  }

  apply(input: MicroCompactionInput): MicroCompactionResult {
    const trimToTokens = input.trimToTokens
      ?? this.options.trimToTokens
      ?? Math.max(256, Math.floor((input.trimToBytes ?? this.options.trimToBytes ?? 1536) / 2));
    const keepLatest = input.keepLatest ?? this.options.keepLatest ?? 4;

    const toolNamesByCallId = collectToolNamesByCallId(input.messages);
    const protectedToolNames = input.protectedToolNames === null
      ? new Set<string>()
      : input.protectedToolNames === undefined
        ? this.protectedToolNames
        : protectedToolNameSet(input.protectedToolNames);
    const compactableCallIds = this.collectCompactableToolCallIds(input.messages);
    const toolResultIndices = this.collectCompactableToolResultIndices(input.messages, compactableCallIds);

    if (toolResultIndices.length <= keepLatest) {
      return {
        messages: input.messages,
        rewritten: 0,
        rewrittenBytes: 0,
        toolCallIds: [],
        appliedTrigger: "skipped",
      };
    }

    const rewriteUntil = toolResultIndices[toolResultIndices.length - keepLatest]! - 1;
    const rewrittenIds: string[] = [];
    let rewrittenBytes = 0;

    const messages = input.messages.map((message, index) => {
      if (index > rewriteUntil) {
        return message;
      }
      if (message.role !== "user") {
        return message;
      }
      let touched = false;
      const newContent = message.content.map((block) => {
        if (block.type !== "tool_result") {
          // Clear standalone multimedia blocks (from supplementalMessages)
          // in older user messages that are within the rewrite window.
          if (block.type === "image" || block.type === "pdf") {
            touched = true;
            rewrittenBytes += "data" in block ? (block as { data: string }).data.length : 0;
            return {
              type: "text" as const,
              text: block.type === "image" ? "[image cleared]" : "[document cleared]",
            };
          }
          return block;
        }
        if (!compactableCallIds.has(block.toolCallId)) {
          return block;
        }
        const flattenedText = flattenToolResultBlockText(block as CanonicalToolResultBlock);
        const existingPreview = extractCompactedPreview(flattenedText);
        // Re-running the normal 768-token pass is idempotent. An emergency
        // pass may intentionally request a smaller bound, in which case the
        // bounded preview can be tightened without touching the durable copy.
        const boundedContentBudget = Math.max(
          64,
          trimToTokens - countTokens(`${MICROCOMPACT_CLEARED}\n\nPreview:\n`) - 4,
        );
        // The preview's explicit `...[truncated]...` separator adds a few
        // tokens outside the content budget. A small tolerance recognizes a
        // preview produced by this same pass without weakening the emergency
        // 768 -> 256 downgrade.
        if (existingPreview !== undefined && (
          countTokens(existingPreview) <= boundedContentBudget
          || countTokens(flattenedText) <= trimToTokens + 32
        )) {
          return block;
        }
        if (isProtectedToolCallId(block.toolCallId, toolNamesByCallId, protectedToolNames)) {
          return block;
        }
        const size = this.estimateToolResultSize(block as CanonicalToolResultBlock);
        const sourceText = existingPreview ?? flattenedText;
        if (countTokens(sourceText) <= trimToTokens && existingPreview === undefined) {
          return block;
        }
        touched = true;
        rewrittenIds.push(block.toolCallId);
        rewrittenBytes += size;
        return {
          ...block,
          content: [
            {
              type: "text" as const,
              text: compactToolResultText(sourceText, trimToTokens),
            },
          ],
        };
      });
      return touched ? { ...message, content: newContent } : message;
    });

    return {
      messages,
      rewritten: rewrittenIds.length,
      rewrittenBytes,
      toolCallIds: rewrittenIds,
      appliedTrigger: rewrittenIds.length > 0 ? "time_based" : "skipped",
    };
  }

  private collectCompactableToolCallIds(messages: CanonicalMessage[]): Set<string> {
    const ids = new Set<string>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type === "tool_call" && COMPACTABLE_TOOL_NAMES.has(block.name)) {
          ids.add(block.id);
        }
      }
    }
    return ids;
  }

  private collectCompactableToolResultIndices(
    messages: CanonicalMessage[],
    compactableCallIds: Set<string>,
  ): number[] {
    const indices: number[] = [];
    messages.forEach((message, index) => {
      if (message.role !== "user") return;
      const hasCompactable = message.content.some(
        (block) => block.type === "tool_result" && compactableCallIds.has(block.toolCallId),
      );
      if (hasCompactable) indices.push(index);
    });
    return indices;
  }

  private estimateToolResultSize(block: CanonicalToolResultBlock): number {
    let size = 0;
    for (const item of block.content) {
      if (item.type === "text") {
        size += item.text.length;
      } else if (item.type === "image" || item.type === "pdf") {
        size += item.data.length;
      }
    }
    return size;
  }
}

function extractCompactedPreview(text: string): string | undefined {
  const marker = `${MICROCOMPACT_CLEARED}\n\nPreview:\n`;
  if (!text.trimStart().startsWith(MICROCOMPACT_CLEARED)) return undefined;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return "";
  return text.slice(markerIndex + marker.length).trim();
}

function compactToolResultText(text: string, trimToTokens: number): string {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return MICROCOMPACT_CLEARED;
  }
  const marker = `${MICROCOMPACT_CLEARED}\n\nPreview:\n`;
  const contentBudget = Math.max(64, trimToTokens - countTokens(marker) - 4);
  const headBudget = Math.max(32, Math.floor(contentBudget * 0.7));
  const tailBudget = Math.max(16, contentBudget - headBudget);
  const head = takeTokenPrefix(normalized, headBudget);
  const tail = takeTokenSuffix(normalized, tailBudget);
  const preview = countTokens(normalized) <= contentBudget
    ? normalized
    : `${head}\n...[truncated]...\n${tail}`;
  return `${MICROCOMPACT_CLEARED}\n\nPreview:\n${preview}`;
}

function takeTokenPrefix(text: string, budget: number): string {
  if (countTokens(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low).trimEnd();
}

function takeTokenSuffix(text: string, budget: number): string {
  if (countTokens(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (countTokens(text.slice(text.length - mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return text.slice(text.length - low).trimStart();
}
