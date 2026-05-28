import type {
  CanonicalMessage,
  CanonicalToolResultBlock,
} from "../../model/index.js";
import { COMPACTABLE_TOOL_NAMES } from "./CachedMicroCompactionEngine.js";

export const MICROCOMPACT_CLEARED = "[Old tool result content cleared]";

export type MicroCompactionInput = {
  messages: CanonicalMessage[];
  /** Now() epoch in ms used to determine `idle for X` time-based decisions. */
  nowMs?: number;
  /** Microcompact only kicks in after this many ms of idle (legacy default ~5min). */
  idleMs?: number;
  /** Max bytes per tool_result allowed to remain after rewrite (legacy default ~512). */
  trimToBytes?: number;
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
  constructor(private readonly options: { keepLatest?: number; trimToBytes?: number } = {}) {}

  apply(input: MicroCompactionInput): MicroCompactionResult {
    const trimToBytes = input.trimToBytes ?? this.options.trimToBytes ?? 1536;
    const keepLatest = this.options.keepLatest ?? 1;

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
        const size = this.estimateToolResultSize(block as CanonicalToolResultBlock);
        if (size <= trimToBytes) {
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
              text: MICROCOMPACT_CLEARED,
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
