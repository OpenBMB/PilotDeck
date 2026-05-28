import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalToolCallBlock,
  CanonicalToolResultBlock,
} from "./canonical.js";

/**
 * Deep-clone a single content block. Handles nested structures that a plain
 * spread would share by reference:
 *
 *  - `tool_result` → deep-clones the inner `content` array and each element.
 *  - `tool_call`   → `structuredClone`s the opaque `input` payload.
 *  - All other block types have only primitive-valued properties; a spread
 *    is sufficient.
 *
 * The `raw` field is intentionally left as a shared reference — it is a
 * read-only provider echo used only for debugging and never mutated.
 */
export function cloneContentBlock(block: CanonicalContentBlock): CanonicalContentBlock {
  if (block.type === "tool_result") {
    const tr = block as CanonicalToolResultBlock;
    return {
      ...tr,
      content: tr.content.map((item) => ({ ...item })),
    };
  }
  if (block.type === "tool_call") {
    const tc = block as CanonicalToolCallBlock;
    return {
      ...tc,
      input: tc.input !== undefined ? structuredClone(tc.input) : tc.input,
    };
  }
  return { ...block };
}

export function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: message.content.map(cloneContentBlock),
  };
}

export function cloneMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map(cloneMessage);
}
