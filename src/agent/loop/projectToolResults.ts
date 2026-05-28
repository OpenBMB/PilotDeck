import type { CanonicalContentBlock, CanonicalMessage, CanonicalToolResultContentBlock } from "../../model/index.js";
import { toCanonicalToolResultBlock, type PilotDeckToolResult, type PilotDeckToolResultContent } from "../../tool/index.js";

function toCanonicalSupplementalBlock(content: PilotDeckToolResultContent): CanonicalToolResultContentBlock {
  if (content.type === "image") {
    return {
      type: "image",
      source: "base64",
      data: content.data,
      mimeType: content.mimeType,
      bytes: content.bytes,
      detail: content.detail,
    };
  }
  if (content.type === "pdf") {
    return {
      type: "pdf",
      source: "base64",
      data: content.data,
      mimeType: content.mimeType,
      bytes: content.bytes,
      pages: content.pages,
    };
  }
  return { type: "text", text: content.type === "text" ? content.text : JSON.stringify(content) };
}

export function projectToolResults(results: PilotDeckToolResult[]): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  const toolResultContent: CanonicalContentBlock[] = [];
  for (const result of results) {
    toolResultContent.push(toCanonicalToolResultBlock(result));
  }
  messages.push({ role: "user", content: toolResultContent });

  for (const result of results) {
    if (result.supplementalMessages) {
      for (const msg of result.supplementalMessages) {
        const blocks: CanonicalContentBlock[] = msg.content.map(toCanonicalSupplementalBlock);
        messages.push({ role: "user", content: blocks });
      }
    }
  }

  return messages;
}
