/**
 * S4 — drop any assistant `tool_call` block whose paired `tool_result` is
 * missing from the message history. Without this scrub, providers reject the
 * subagent's first request because every advertised tool call needs a matching
 * tool_result somewhere later in the sequence.
 *
 * Mirrors legacy `runAgent.ts:371` (`filterIncompleteToolCalls`).
 *
 * Algorithm:
 *   1. First pass: collect every `tool_result.toolCallId` seen.
 *   2. Second pass: for every assistant message, drop any `tool_call` block
 *      whose `id` is not in the seen set.
 *   3. Drop assistant messages that become empty after filtering.
 */

import type { CanonicalMessage } from "../../model/index.js";
import { messageContent } from "../../model/protocol/clone.js";

export function filterIncompleteToolCalls(
  messages: CanonicalMessage[],
): CanonicalMessage[] {
  const completedIds = new Set<string>();
  for (const message of messages) {
    for (const block of messageContent(message)) {
      if (block.type === "tool_result" || block.type === "tool_result_reference") {
        completedIds.add(block.toolCallId);
      }
    }
  }
  const out: CanonicalMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }
    const filtered = messageContent(message).filter((block) => {
      if (block.type !== "tool_call") return true;
      return completedIds.has(block.id);
    });
    if (filtered.length === 0) continue;
    out.push({ role: "assistant", content: filtered });
  }
  return out;
}
