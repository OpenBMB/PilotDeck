import type { CanonicalMessage } from "./canonical.js";

export const COMPACTION_CONTINUATION_TEXT =
  "[system: the conversation above has been compacted. please continue with the current task.]";

const INTERNAL_USER_TEXT_PREFIXES = [
  "<compact-boundary",
  "<snip-boundary",
  "<memory-context>",
  "<internal-compaction-control",
  "<hook_context",
];

/** Distinguish task-bearing user input from tool output and injected context. */
export function isRealUserRequestMessage(message: CanonicalMessage): boolean {
  if (message.role !== "user" || message.metadata?.synthetic === true) {
    return false;
  }

  return message.content.some((block) => {
    if (block.type === "tool_result" || block.type === "tool_result_reference"
      || (block.type === "media_reference" && typeof block.toolCallId === "string" && block.toolCallId.length > 0)) {
      return false;
    }
    if (block.type !== "text") {
      return true;
    }
    const text = block.text.trim();
    return text.length > 0
      && text !== COMPACTION_CONTINUATION_TEXT
      && !INTERNAL_USER_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
  });
}
