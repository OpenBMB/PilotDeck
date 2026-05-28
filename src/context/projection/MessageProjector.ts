import type { CanonicalMessage, CanonicalContentBlock } from "../../model/index.js";

export type MessageProjectorInput = {
  messages: CanonicalMessage[];
  /** Maximum number of recent messages to retain (post-boundary slice). */
  maxMessages?: number;
};

export type MessageProjectorResult = {
  messages: CanonicalMessage[];
  /** Number of messages dropped by sliding-window or boundary slicing. */
  droppedCount: number;
  /** Diagnostic flags emitted by the projection. */
  warnings: Array<{
    code: "context_truncated" | "tool_result_orphaned" | "tool_call_unmatched" | "tool_result_injected";
    message: string;
  }>;
};

/**
 * Project canonical messages so the output is safe to send to a model:
 *  1. Apply a tool-pair-safe sliding window when `maxMessages` is set.
 *  2. Ensure every assistant `tool_call` has a matching `tool_result`
 *     immediately following — inject placeholder results for any that are
 *     missing so the OpenAI API never rejects the payload.
 *  3. Strip orphaned `tool_result` blocks whose `tool_call` was dropped.
 */
export class MessageProjector {
  project(input: MessageProjectorInput): MessageProjectorResult {
    const warnings: MessageProjectorResult["warnings"] = [];

    let projected = input.messages;
    let droppedCount = 0;

    if (input.maxMessages !== undefined && projected.length > input.maxMessages) {
      const result = toolPairSafeTruncate(projected, input.maxMessages);
      droppedCount = result.droppedCount;
      projected = result.messages;
      if (droppedCount > 0) {
        warnings.push({
          code: "context_truncated",
          message: `Truncated ${droppedCount} message(s) to respect maxMessages=${input.maxMessages}.`,
        });
      }
    }

    projected = repairToolResultPairing(projected, warnings);

    return { messages: projected, droppedCount, warnings };
  }
}

/**
 * Truncate messages to at most `max` while never cutting between an
 * assistant `tool_calls` message and its subsequent `tool_result` messages.
 * The cut point is pushed earlier until it lands on a safe turn boundary.
 */
function toolPairSafeTruncate(
  messages: CanonicalMessage[],
  max: number,
): { messages: CanonicalMessage[]; droppedCount: number } {
  if (messages.length <= max) return { messages, droppedCount: 0 };

  let cutIndex = messages.length - max;

  // Walk forward from the naive cut point to find a safe boundary:
  // skip past any message that is a tool_result-only user message (these
  // belong to the assistant tool_calls *before* them).
  while (cutIndex < messages.length && isToolResultOnly(messages[cutIndex])) {
    cutIndex++;
  }

  // Also skip if we'd start on an assistant message with tool_calls
  // whose results come right after — include the whole tool exchange.
  // But check: if the message at cutIndex is assistant with tool_calls,
  // we should include it only if the *following* message has matching results.
  // Since we want to *drop* earlier messages, move cut forward past the
  // tool exchange.
  if (cutIndex < messages.length && messages[cutIndex].role === "assistant" && hasToolCalls(messages[cutIndex])) {
    // If the previous message (cutIndex-1) is also assistant with tool_calls,
    // that's the one we'd be orphaning; this is fine — we've already moved
    // past its results. No action needed here.
  }

  const sliced = messages.slice(cutIndex);
  return { messages: sliced, droppedCount: cutIndex };
}

/**
 * Walk through the conversation and:
 *  - Inject a placeholder `tool_result` user message for any assistant
 *    `tool_call` that has no matching result (fixes the OpenAI API error).
 *  - Strip orphaned `tool_result` blocks whose `tool_call` was dropped.
 */
function repairToolResultPairing(
  messages: CanonicalMessage[],
  warnings: MessageProjectorResult["warnings"],
): CanonicalMessage[] {
  const output: CanonicalMessage[] = [];
  let pendingToolCallIds: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.role === "assistant") {
      // Before processing a new assistant message, flush any unmatched
      // tool_calls from a *previous* assistant message.
      if (pendingToolCallIds.length > 0) {
        injectPlaceholderResults(pendingToolCallIds, output, warnings);
        pendingToolCallIds = [];
      }
      pendingToolCallIds = collectToolCallIds(message);
      output.push(message);
      continue;
    }

    // User (or system) message.
    const pendingSet = new Set(pendingToolCallIds);
    const seen = new Set<string>();
    for (const block of message.content) {
      if (block.type === "tool_result" || block.type === "tool_result_reference") {
        seen.add(block.toolCallId);
      }
    }

    // Strip orphaned tool_results / tool_result_references (their tool_call was truncated away).
    const hasOrphans = [...seen].some((id) => !pendingSet.has(id));
    let cleanedMessage = message;
    if (hasOrphans) {
      const kept: CanonicalContentBlock[] = [];
      for (const block of message.content) {
        if (
          (block.type === "tool_result" || block.type === "tool_result_reference") &&
          !pendingSet.has(block.toolCallId)
        ) {
          warnings.push({
            code: "tool_result_orphaned",
            message: `tool_result ${block.toolCallId} has no matching tool_call — removed.`,
          });
        } else {
          kept.push(block);
        }
      }
      if (kept.length === 0) {
        // Entire message was orphaned tool_results; skip it.
        // Remove matched ones from pending before continuing.
        for (const id of seen) pendingToolCallIds = pendingToolCallIds.filter((pid) => pid !== id);
        continue;
      }
      cleanedMessage = { ...message, content: kept };
    }

    // Check for unmatched tool_calls — they'll be flushed as placeholders
    // when the *next* assistant message arrives or at the end.
    const matched = [...seen].filter((id) => pendingSet.has(id));
    pendingToolCallIds = pendingToolCallIds.filter((id) => !matched.includes(id));

    output.push(cleanedMessage);
  }

  // Flush any remaining unmatched tool_calls at the end of the conversation.
  if (pendingToolCallIds.length > 0) {
    injectPlaceholderResults(pendingToolCallIds, output, warnings);
  }

  return output;
}

function injectPlaceholderResults(
  toolCallIds: string[],
  output: CanonicalMessage[],
  warnings: MessageProjectorResult["warnings"],
): void {
  const blocks: CanonicalContentBlock[] = toolCallIds.map((id) => ({
    type: "tool_result" as const,
    toolCallId: id,
    content: [{ type: "text" as const, text: "[result truncated]" }],
  }));
  output.push({ role: "user", content: blocks });
  for (const id of toolCallIds) {
    warnings.push({
      code: "tool_result_injected",
      message: `Injected placeholder tool_result for unmatched tool_call ${id}.`,
    });
  }
}

function collectToolCallIds(message: CanonicalMessage): string[] {
  return message.content
    .filter((block): block is { type: "tool_call"; id: string; name: string; input: unknown } =>
      block.type === "tool_call",
    )
    .map((block) => block.id);
}

function hasToolCalls(message: CanonicalMessage): boolean {
  return message.content.some((block) => block.type === "tool_call");
}

function isToolResultOnly(message: CanonicalMessage): boolean {
  return message.content.length > 0 && message.content.every(
    (block) => block.type === "tool_result" || block.type === "tool_result_reference",
  );
}
