import {
  flattenToolResultBlockText,
  type CanonicalMessage,
  type CanonicalModelEvent,
  type CanonicalModelRequest,
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

/**
 * Estimates the full input size of an upcoming request: messages + system
 * prompt + tool schemas. Message-only counts under-price the stable cache
 * prefix (system + tools), so cache-aware cost comparisons must use this.
 */
export function estimateRequestInputTokens(request: CanonicalModelRequest): number {
  let total = countMessagesTokens(request.messages);
  if (request.systemPrompt) {
    total += countTokens(request.systemPrompt);
  }
  for (const tool of request.tools ?? []) {
    total += countTokens(`${tool.name}${tool.description ?? ""}${JSON.stringify(tool.inputSchema)}`);
  }
  return total;
}

/** No-op retained for API compatibility (js-tiktoken needs no manual free). */
export function dispose(): void {}
