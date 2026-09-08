import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";

/**
 * Shared tool_call / tool_result pair integrity helpers.
 *
 * Used by both SnipEngine (S4) and CompactionEngine to ensure that no
 * dangling tool_call or tool_result survives a message split (snip boundary
 * or compact boundary).
 */

export function collectToolCallIds(messages: CanonicalMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "tool_call") ids.add(block.id);
    }
  }
  return ids;
}

export function collectToolResultIds(messages: CanonicalMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (isDirectToolResultBlock(block)) {
        ids.add(block.toolCallId);
      }
    }
  }
  return ids;
}

/**
 * Remove tool_call blocks from assistant messages whose id is NOT in `pairedIds`.
 * Messages that become empty after filtering are dropped entirely.
 */
export function stripUnpairedToolCalls(
  messages: CanonicalMessage[],
  pairedIds: Set<string>,
): CanonicalMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const filtered = message.content.filter(
      (block) => block.type !== "tool_call" || pairedIds.has(block.id),
    );
    return filtered.length === message.content.length
      ? message
      : { ...message, content: filtered };
  }).filter((m) => m.content.length > 0);
}

/**
 * Remove tool-result blocks from user messages whose
 * toolCallId is NOT in `pairedIds`.
 * Messages that become empty after filtering are dropped entirely.
 */
export function stripUnpairedToolResults(
  messages: CanonicalMessage[],
  pairedIds: Set<string>,
): CanonicalMessage[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const filtered = message.content.filter(
      (block) =>
        (!isDirectToolResultBlock(block) && !isMediaReferenceWithId(block)) ||
        pairedIds.has(block.toolCallId),
    );
    return filtered.length === message.content.length
      ? message
      : { ...message, content: filtered };
  }).filter((m) => m.content.length > 0);
}

function isDirectToolResultBlock(block: CanonicalContentBlock): block is Extract<
  CanonicalContentBlock,
  { type: "tool_result" | "tool_result_reference" }
> {
  return block.type === "tool_result" || block.type === "tool_result_reference";
}

function isMediaReferenceWithId(
  block: CanonicalContentBlock,
): block is Extract<CanonicalContentBlock, { type: "media_reference" }> & { toolCallId: string } {
  return block.type === "media_reference" && typeof block.toolCallId === "string" && block.toolCallId.length > 0;
}

const CONTINUATION_TEXT =
  "[system: the conversation above has been compacted. please continue with the current task.]";

const INTERNAL_USER_TEXT_PREFIXES = [
  "<compact-boundary",
  "<snip-boundary",
  "<memory-context>",
  "<internal-compaction-control",
  "<hook_context",
];

/** True only for an end-user request that can anchor a retained live tail. */
export function isRealUserRequestMessage(message: CanonicalMessage): boolean {
  if (message.role !== "user" || message.metadata?.synthetic === true) {
    return false;
  }

  return message.content.some((block) => {
    if (isDirectToolResultBlock(block) || isMediaReferenceWithId(block)) {
      return false;
    }
    if (block.type !== "text") {
      return true;
    }
    const text = block.text.trim();
    return text.length > 0
      && text !== CONTINUATION_TEXT
      && !INTERNAL_USER_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
  });
}

/**
 * If the last message is role=assistant, append a sentinel user message so
 * providers that reject assistant-message prefill (e.g. Amazon Bedrock) do
 * not return 400.  No-op when messages is empty or already ends with user.
 */
export function ensureTrailingUserMessage(
  messages: CanonicalMessage[],
): CanonicalMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return messages;
  return [
    ...messages,
    { role: "user", content: [{ type: "text", text: CONTINUATION_TEXT }] },
  ];
}
