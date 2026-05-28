import type { CanonicalContentBlock, CanonicalMessage, CanonicalToolResultBlock } from "../../model/index.js";

/**
 * Strip image and PDF/document blocks from messages before sending to the
 * compaction summarizer. This prevents the compaction API call itself from
 * hitting prompt-too-long limits due to accumulated base64 data.
 *
 * Replaces:
 * - Top-level `image` blocks → `[image]`
 * - Top-level `pdf` blocks → `[document]`
 * - `image`/`pdf` blocks nested inside `tool_result.content` → same markers
 *
 * Only user messages are processed (assistant messages don't contain media).
 */
export function stripMultimediaFromMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;

    let hasMedia = false;
    const newContent: CanonicalContentBlock[] = message.content.map((block) => {
      if (block.type === "image") {
        hasMedia = true;
        return { type: "text" as const, text: "[image]" };
      }
      if (block.type === "pdf") {
        hasMedia = true;
        return { type: "text" as const, text: "[document]" };
      }
      if (block.type === "tool_result") {
        let toolHasMedia = false;
        const newToolContent = (block as CanonicalToolResultBlock).content.map((item) => {
          if (item.type === "image") {
            toolHasMedia = true;
            return { type: "text" as const, text: "[image]" };
          }
          if (item.type === "pdf") {
            toolHasMedia = true;
            return { type: "text" as const, text: "[document]" };
          }
          return item;
        });
        if (toolHasMedia) {
          hasMedia = true;
          return { ...block, content: newToolContent } as CanonicalContentBlock;
        }
      }
      return block;
    });

    return hasMedia ? { ...message, content: newContent } : message;
  });
}
