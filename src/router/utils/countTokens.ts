import {
  flattenToolResultBlockText,
  type CanonicalMessage,
  type CanonicalModelEvent,
} from "../../model/index.js";
import { countTokens } from "../../context/budget/tokenizer.js";

export { countTokens };

export function countMessagesTokens(messages: CanonicalMessage[]): number {
  const chunks: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
        case "thinking":
          chunks.push(block.text);
          break;
        case "tool_call":
          if (block.input !== undefined) {
            chunks.push(typeof block.input === "string" ? block.input : JSON.stringify(block.input));
          }
          break;
        case "tool_result":
          chunks.push(flattenToolResultBlockText(block));
          break;
      }
    }
  }
  return countTokens(chunks.join("\n"));
}

export function countResponseTokens(events: CanonicalModelEvent[]): number {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type === "text_delta") {
      chunks.push(event.text);
    } else if (event.type === "thinking_delta") {
      chunks.push(event.text);
    } else if (event.type === "tool_call_delta") {
      chunks.push(event.delta);
    }
  }
  if (chunks.length === 0) return 0;
  return countTokens(chunks.join(""));
}

/** No-op retained for API compatibility (js-tiktoken needs no manual free). */
export function dispose(): void {}
